import gzip
import io
import json
import struct
from unittest.mock import Mock

import numpy as np
from PIL import Image
import pytest

from backend.tracker.segmentation import validate_objects, segment_file
import backend.handler as h
from conftest import make_event

POINTS = [{'points': [{'x': .25, 'y': .5, 'label': 1}]}]

@pytest.mark.parametrize('value', [None, [], [{'points': []}], [{'points': [{'x': 0, 'y': 0, 'label': 0}]}],
                         [{'points': [{'x': float('nan'), 'y': .5, 'label': 1}]}]])
def test_selection_validation(value):
    with pytest.raises(ValueError):
        validate_objects(value)


def test_pipeline_unions_objects_and_returns_every_frame(tmp_path):
    source, target = tmp_path / 'input.gif', tmp_path / 'masks.gz'
    images = [Image.new('RGB', (3, 2), color) for color in ('red', 'green', 'blue')]
    images[0].save(source, save_all=True, append_images=images[1:], duration=[70,130,250], loop=2)
    predictor = Mock()
    def propagate(state):
        for index in range(3):
            logits = np.full((2,1,2,3), -1.)
            logits[0,0,0,index] = 1
            logits[1,0,1,index] = 1
            tensor = Mock(); tensor.cpu.return_value.numpy.return_value = logits
            yield index, [1,2], tensor
    predictor.propagate_in_video.side_effect = propagate
    stats = segment_file(source, target, POINTS + POINTS, predictor)
    assert stats['frames'] == 3
    predictor.init_state.assert_called_once()
    assert predictor.init_state.call_args.kwargs['offload_state_to_cpu'] is True
    assert predictor.add_new_points_or_box.call_count == 2
    raw = gzip.decompress(target.read_bytes())
    size = struct.unpack('<I',raw[:4])[0]
    assert json.loads(raw[4:4+size]) == {'version':1,'width':3,'height':2,'frames':3}
    assert list(raw[4+size:]) == [0b10010000,0b01001000,0b00100100]
    predictor.reset_state.assert_called_once()


def test_incomplete_masks_fail_and_release_predictor(tmp_path):
    source = tmp_path / 'image.png'
    Image.new('RGB',(2,2)).save(source)
    predictor = Mock(); predictor.propagate_in_video.return_value=[]
    with pytest.raises(ValueError,match='every frame'):
        segment_file(source,tmp_path/'out.gz',POINTS,predictor)
    predictor.reset_state.assert_called_once()


@pytest.fixture
def issued(monkeypatch, mock_aws):
    monkeypatch.setattr(h,'MODAL_SEGMENTER_URL','https://segment.test')
    remote=Mock(return_value={'call_id':'fc-test'})
    monkeypatch.setattr(h,'_segment_remote',remote)
    mock_aws['s3'].head_object.return_value={'ContentLength':100}
    response=h.handler(make_event('/api/segment/presign',{'content_type':'image/gif'}),None)
    assert response['statusCode']==200
    return json.loads(response['body'])['job_id'],remote,mock_aws


def test_broker_submits_private_urls_and_points(issued):
    job,remote,aws=issued
    response=h.handler(make_event('/api/segment/submit',{'job_id':job,'objects':POINTS,
        'input_url':'https://attacker.invalid','call_id':'fc-ignored'}),None)
    assert response['statusCode']==202
    route,payload=remote.call_args.args
    assert route=='/segment' and payload['objects']==POINTS
    assert payload['input_url']=='https://s3.test.com/presigned'
    aws['s3'].copy_object.assert_called_once()
    assert aws['s3'].copy_object.call_args.kwargs['Key'].endswith('.source')
    assert any(c.kwargs.get('ExpressionAttributeValues',{}).get(':call')=='fc-test' for c in aws['table'].update_item.call_args_list)


def test_broker_rejects_unknown_and_bad_selection(issued):
    job,remote,_=issued
    assert h.handler(make_event('/api/segment/submit',{'job_id':'f'*32,'objects':POINTS}),None)['statusCode']==400
    assert h.handler(make_event('/api/segment/submit',{'job_id':job,'objects':[]}),None)['statusCode']==400
    remote.assert_not_called()


def test_broker_masks_download_and_cancellation_cleanup(issued):
    job,remote,aws=issued
    aws['table'].get_item.return_value={}
    # The default fixture holds issued records in a side effect.
    item=aws['table'].get_item(Key={'job_id':job})['Item']
    item['call_id']='fc-test'
    remote.return_value={'state':'complete','stats':{'frames':5000}}
    response=h.handler(make_event('/api/segment/status',{'job_id':job}),None)
    body=json.loads(response['body'])
    assert body['stats']['frames']==5000 and 'mask_url' in body
    remote.assert_called_with('/status',{'call_id':'fc-test'})
    remote.return_value={'state':'cancelled'}
    response=h.handler(make_event('/api/segment/cancel',{'job_id':job}),None)
    assert json.loads(response['body'])['state']=='cancelled'
    assert any(c.kwargs['Key'].endswith('.masks.gz') for c in aws['s3'].delete_object.call_args_list)


def test_cancel_while_submit_is_pending_does_not_claim_success(issued):
    job,remote,_=issued
    assert h.handler(make_event('/api/segment/cancel',{'job_id':job}),None)['statusCode']==409
    remote.assert_not_called()

@pytest.mark.parametrize('size', [0, 100 * 1024 * 1024 + 1])
def test_invalid_upload_size_never_launches_compute(issued, size):
    job, remote, aws = issued
    aws['s3'].head_object.return_value = {'ContentLength': size}
    response = h.handler(make_event('/api/segment/submit', {'job_id': job, 'objects': POINTS}), None)
    assert response['statusCode'] == 400
    remote.assert_not_called()


def test_kill_switch_still_permits_cancellation(issued, monkeypatch):
    job, remote, aws = issued
    item = aws['table'].get_item(Key={'job_id': job})['Item']
    item['call_id'] = 'fc-test'
    monkeypatch.setattr(h, 'FEATURES_DISABLED', {'segment'})
    assert h.handler(make_event('/api/segment/submit', {'job_id': job, 'objects': POINTS}), None)['statusCode'] == 503
    remote.return_value = {'state': 'cancelled'}
    response = h.handler(make_event('/api/segment/cancel', {'job_id': job}), None)
    assert json.loads(response['body'])['state'] == 'cancelled'
    remote.assert_called_once_with('/cancel', {'call_id': 'fc-test'})


def test_keep_and_exclude_points_reach_predictor_for_their_subject(tmp_path):
    source = tmp_path / 'source.png'
    Image.new('RGB', (100, 50), 'red').save(source)
    predictor = Mock()
    tensor = Mock()
    tensor.cpu.return_value.numpy.return_value = np.ones((2, 1, 50, 100))
    predictor.propagate_in_video.return_value = [(0, [1, 2], tensor)]
    objects = [
        {'points': [{'x': .2, 'y': .4, 'label': 1}, {'x': .8, 'y': .6, 'label': 0}]},
        {'points': [{'x': .1, 'y': .2, 'label': 0}, {'x': .5, 'y': .5, 'label': 1}]},
    ]
    segment_file(source, tmp_path / 'masks.gz', objects, predictor)
    for i, (expected_points, expected_labels) in enumerate([
        ([[20, 20], [80, 30]], [1, 0]),
        ([[10, 10], [50, 25]], [0, 1]),
    ]):
        prompt = predictor.add_new_points_or_box.call_args_list[i].kwargs
        assert prompt['obj_id'] == i + 1
        np.testing.assert_array_equal(prompt['points'], expected_points)
        np.testing.assert_array_equal(prompt['labels'], expected_labels)
