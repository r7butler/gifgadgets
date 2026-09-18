import gzip
import io
import json
import struct
from unittest.mock import Mock

import numpy as np
from PIL import Image
import pytest

from backend.tracker.segmentation import (
    TrackerSegmenter, load_frames, segment_file, validate_objects)
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
    segmenter = Mock()
    def masks(frames, objects):
        assert [f.size for f in frames] == [(3, 2)] * 3
        for index in range(3):
            union = np.zeros((2, 3), dtype=bool)
            # Two objects, one pixel each, so the packed byte proves the union.
            union[0, index] = True
            union[1, index] = True
            yield index, union
    segmenter.masks.side_effect = masks
    stats = segment_file(source, target, POINTS + POINTS, segmenter)
    assert stats['frames'] == 3 and stats['objects'] == 2
    raw = gzip.decompress(target.read_bytes())
    size = struct.unpack('<I',raw[:4])[0]
    assert json.loads(raw[4:4+size]) == {'version':1,'width':3,'height':2,'frames':3}
    assert list(raw[4+size:]) == [0b10010000,0b01001000,0b00100100]
    segmenter.release.assert_called_once()


def test_incomplete_masks_fail_and_release_the_session(tmp_path):
    source = tmp_path / 'image.png'
    Image.new('RGB',(2,2)).save(source)
    segmenter = Mock(); segmenter.masks.return_value = []
    with pytest.raises(ValueError,match='every frame'):
        segment_file(source,tmp_path/'out.gz',POINTS,segmenter)
    segmenter.release.assert_called_once()


def test_a_wrongly_shaped_or_repeated_mask_is_refused(tmp_path):
    source = tmp_path / 'image.png'
    Image.new('RGB', (4, 3)).save(source)
    for union, message in [(np.zeros((9, 9), dtype=bool), 'unexpected mask dimensions'),
                           (np.zeros((3, 4), dtype=bool), None)]:
        segmenter = Mock(); segmenter.masks.return_value = [(0, union)]
        if message:
            with pytest.raises(ValueError, match=message):
                segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
        else:
            assert segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)['frames'] == 1
        segmenter.release.assert_called_once()
    # A frame delivered twice would silently overwrite the first result.
    segmenter = Mock()
    segmenter.masks.return_value = [(0, np.zeros((3, 4), dtype=bool))] * 2
    with pytest.raises(ValueError, match='invalid frame sequence'):
        segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)


def test_frames_are_downscaled_but_reported_at_their_original_size(tmp_path):
    source = tmp_path / 'big.png'
    Image.new('RGB', (2048, 1024), 'red').save(source)
    frames, original = load_frames(source)
    assert original == (2048, 1024), 'stats must describe the file the user gave us'
    assert frames[0].size == (1024, 512), 'the model never sees more than MAX_SIDE'
    segmenter = Mock()
    segmenter.masks.return_value = [(0, np.zeros((512, 1024), dtype=bool))]
    stats = segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
    assert (stats['width'], stats['height']) == (2048, 1024)


def test_unsupported_formats_never_reach_the_gpu(tmp_path):
    source = tmp_path / 'clip.bmp'
    Image.new('RGB', (4, 4)).save(source)
    segmenter = Mock()
    with pytest.raises(ValueError, match='GIF, PNG, JPG or WebP'):
        segment_file(source, tmp_path / 'out.gz', POINTS, segmenter)
    segmenter.masks.assert_not_called()


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


def test_keep_and_exclude_points_reach_the_model_for_their_subject():
    """Selections are normalised in the browser and must land on the right pixels.

    This is the arithmetic between a click and the GPU, so it is asserted against
    the real TrackerSegmenter with the model and processor stubbed out.
    """
    frames = [Image.new('RGB', (100, 50), 'red')]
    objects = [
        {'points': [{'x': .2, 'y': .4, 'label': 1}, {'x': .8, 'y': .6, 'label': 0}]},
        {'points': [{'x': .1, 'y': .2, 'label': 0}, {'x': .5, 'y': .5, 'label': 1}]},
    ]
    model, processor = Mock(), Mock()
    frame = Mock(); frame.frame_idx = 0
    model.propagate_in_video_iterator.return_value = [frame]
    logits = Mock()
    # Two objects, each covering one half of the frame: the union is everything.
    stack = np.full((2, 1, 50, 100), -1.)
    stack[0, 0, :, :50] = 1
    stack[1, 0, :, 50:] = 1
    logits.cpu.return_value.numpy.return_value = stack
    processor.post_process_masks.return_value = [logits]

    segmenter = TrackerSegmenter(model, processor, device='cpu')
    produced = list(segmenter.masks(frames, objects))

    prompt = processor.add_inputs_to_inference_session.call_args.kwargs
    assert prompt['frame_idx'] == 0
    assert prompt['obj_ids'] == [1, 2], 'object ids must be stable and one-based'
    np.testing.assert_array_equal(prompt['input_points'], [[[[20, 20], [80, 30]], [[10, 10], [50, 25]]]])
    np.testing.assert_array_equal(prompt['input_labels'], [[[1, 0], [0, 1]]])
    # Masks come back at the frame's resolution, not the model's working size.
    assert processor.post_process_masks.call_args.kwargs['original_sizes'] == [[50, 100]]
    assert processor.post_process_masks.call_args.kwargs['binarize'] is False

    (index, union), = produced
    assert index == 0 and union.shape == (50, 100)
    assert union.all(), 'both selections are foreground, so the union covers the frame'

    segmenter.release()
    processor.init_video_session.return_value.reset_inference_session.assert_called_once()


def test_releasing_without_a_session_is_harmless():
    # A file rejected before segmentation still reaches release() in the finally.
    TrackerSegmenter(Mock(), Mock()).release()
