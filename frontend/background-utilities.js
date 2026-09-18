(() => {
  'use strict';
  const $ = name => document.getElementById('utility-' + name);
  const root = document.querySelector('[data-tool]'), gif = root.dataset.gif === 'yes', replace = root.dataset.replace === 'yes';
  let source, backgroundFile, worker, pending, original, maskBuffer, outputURL, busy = false;
  let maskPreview, previewTimer;
  let objects = [{points:[]}], history = [], task, generation = 0;
  const mime = file => ({gif:'image/gif',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'})[file.name.split('.').pop().toLowerCase()];
  const status = message => { $('status').textContent = message; };
  // A description and a set of clicks are alternative prompts, and they run on
  // different halves of the model, so whichever is filled in decides the job.
  const describing = () => $('prompt').value.trim();
  function clearResult() {
    clearTimeout(previewTimer);
    if (outputURL) URL.revokeObjectURL(outputURL);
    outputURL = null; $('download').hidden = $('result-wrap').hidden = true;
    $('result').removeAttribute('src'); $('download').removeAttribute('href');
  }
  function setBusy(value) {
    busy = value;
    document.querySelector('.utility-stage').setAttribute('aria-busy', String(value));
    $('options').disabled = $('background-options').disabled = value || !original;
    $('apply').disabled = value || !maskBuffer;
    $('upload').disabled = $('new').disabled = $('file').disabled = value;
    $('keep').disabled = $('exclude').disabled = value || !original;
    $('cancel').hidden = $('progress').hidden = !value;
    if (value) $('progress').removeAttribute('value');
  }
  function killWorker() {
    worker?.terminate(); worker = null;
    if (pending) { pending.reject(Error('Processing cancelled.')); pending = null; }
  }
  function request(data, transfer = []) {
    return new Promise((resolve,reject) => { pending = {resolve,reject}; worker.postMessage(data,transfer); });
  }
  async function ensureWorker() {
    if (worker) return;
    const ticket = generation;
    const activeWorker = worker = new Worker('/background-worker.js');
    activeWorker.onmessage = ({data}) => {
      if (worker !== activeWorker) return;
      if (data.progress !== undefined) {
        $('progress').max = 100; $('progress').value = data.progress;
        return;
      }
      if (!pending) return;
      const call = pending; pending = null;
      if (data.type === 'error') call.reject(Error(data.message)); else call.resolve(data);
    };
    activeWorker.onerror = () => { if (worker !== activeWorker) return; if (pending) { pending.reject(Error('Image processing failed. Try a smaller file.')); pending = null; } killWorker(); };
    const bytes = await source.arrayBuffer();
    if (ticket !== generation) throw Error('Processing cancelled.');
    original = await request({type:'load',buffer:bytes,mime:mime(source)},[bytes]);
    if (backgroundFile) {
      const buffer = await backgroundFile.arrayBuffer();
      if (ticket !== generation) throw Error('Processing cancelled.');
      await request({type:'background',buffer,mime:mime(backgroundFile)},[buffer]);
    }
    if (maskBuffer) await request({type:'masks',buffer:maskBuffer});
  }
  function draw() {
    if (!original) return;
    const canvas = $('canvas'); canvas.width = original.width; canvas.height = original.height;
    const ctx = canvas.getContext('2d');
    const pixels = new Uint8ClampedArray(original.pixels);
    if (maskPreview && $('overlay').checked) {
      for (let p = 0; p < pixels.length; p += 4) {
        if (maskPreview[p + 3]) {
          pixels[p] = pixels[p] * .6 + 16 * .4;
          pixels[p + 1] = pixels[p + 1] * .6 + 185 * .4;
          pixels[p + 2] = pixels[p + 2] * .6 + 129 * .4;
        }
      }
    }
    ctx.putImageData(new ImageData(pixels,original.width,original.height),0,0);
    const scale = original.width / Math.max(1,canvas.getBoundingClientRect().width), radius = 6 * scale;
    objects.forEach((object,index) => object.points.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x*canvas.width,p.y*canvas.height,radius,0,Math.PI*2);
      ctx.fillStyle = p.label ? '#10b981' : '#ef4444'; ctx.fill(); ctx.lineWidth=2*scale; ctx.strokeStyle='#fff'; ctx.stroke();
      ctx.fillStyle='#fff'; ctx.font=`bold ${10*scale}px sans-serif`; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(index+1,p.x*canvas.width,p.y*canvas.height);
    }));
    const count = objects.reduce((sum,o)=>sum+o.points.length,0), subjects = objects.filter(o=>o.points.length).length;
    $('points').textContent = describing() ? 'Using your description instead of points.'
      : count ? `${count} point${count===1?'':'s'} · ${subjects} subject${subjects===1?'':'s'}` : 'Click a subject to get started.';
    $('undo').disabled = $('clear').disabled = !!describing() || !count;
  }
  function changedSelection() {
    maskBuffer = maskPreview = null; $('overlay-wrap').hidden = true;
    clearResult(); $('apply').disabled = true; $('segment').textContent = 'Preview cutout'; draw();
    selectionMode();
    if (original) status(describing() ? 'Description changed. Choose Preview cutout to see what will be kept.'
      : history.length ? 'Selection changed. Choose Preview cutout to see what will be kept.'
      : 'Describe what to keep, or click the objects to keep, then choose Preview cutout.');
  }
  function selectionMode() {
    const prompt = describing();
    for (const name of ['object','add-object','add-point','keep','exclude','x','y'])
      $(name).disabled = !!prompt;
    if (prompt) {
      $('selection-help').textContent = 'Using your description. Clear it to pick subjects by clicking instead.';
      $('selection-warning').hidden = true;
      return;
    }
    const keep = $('point-mode').value === '1';
    $('keep').setAttribute('aria-pressed', String(keep));
    $('exclude').setAttribute('aria-pressed', String(!keep));
    const index = Number($('object').value), hasKeep = objects[index]?.points.some(p => p.label === 1);
    $('selection-help').textContent = keep
      ? `Click inside Subject ${index + 1} to mark what you want to keep.`
      : hasKeep ? `Click an unwanted area to refine Subject ${index + 1}, then choose Preview cutout. Exclude is an AI hint, not an eraser.`
      : `Subject ${index + 1} needs a Keep point before you can preview. Exclude points only refine a subject you have marked to keep.`;
    const missing = objects.findIndex(o => o.points.length && !o.points.some(p => p.label === 1));
    $('selection-warning').hidden = missing < 0;
    $('selection-warning').textContent = missing < 0 ? '' : `Subject ${missing + 1} only has Exclude points. Select that subject, choose Keep area, and click inside what you want to keep. Your Exclude points will be preserved.`;
  }
  $('prompt').oninput = changedSelection;
  $('keep').onclick = () => { $('point-mode').value = '1'; selectionMode(); };
  $('exclude').onclick = () => { $('point-mode').value = '0'; selectionMode(); };
  $('point-mode').onchange = selectionMode;
  $('object').onchange = selectionMode;
  $('overlay').onchange = draw;
  function resetObjects() {
    objects=[{points:[]}]; history=[]; $('point-mode').value='1'; $('object').innerHTML='<option value="0">Subject 1</option>'; changedSelection();
  }
  function addPoint(x,y) {
    if (busy || !original || describing()) return;
    if (![x,y].every(v=>Number.isFinite(v)&&v>=0&&v<=1)) { status('Point coordinates must be between 0 and 100 percent.'); return; }
    const index = Number($('object').value);
    if (objects[index].points.length >= 128) { status('Use at most 128 points per object.'); return; }
    objects[index].points.push({x,y,label:Number($('point-mode').value)}); history.push(index); changedSelection();
    if (!$('selection-warning').hidden) status($('selection-warning').textContent);
  }
  $('canvas').onclick = event => {
    const box = $('canvas').getBoundingClientRect(); addPoint((event.clientX-box.left)/box.width,(event.clientY-box.top)/box.height);
  };
  $('add-point').onclick = () => addPoint($('x').valueAsNumber/100,$('y').valueAsNumber/100);
  $('add-object').onclick = () => {
    if (objects.length >= 32) { status('Use at most 32 objects.'); return; }
    objects.push({points:[]}); const option=document.createElement('option'); option.value=objects.length-1; option.textContent='Subject '+objects.length; $('object').append(option); $('object').value=option.value; $('point-mode').value='1'; selectionMode(); status('Click inside the next subject you want to keep.');
  };
  $('undo').onclick = () => { if (history.length) objects[history.pop()].points.pop(); changedSelection(); };
  $('clear').onclick = resetObjects;
  async function load(file) {
    if (!file || busy) return;
    const type=mime(file);
    if (!(gif ? type==='image/gif' : ['image/png','image/jpeg','image/webp'].includes(type)) || !file.size || file.size>100*1024*1024) { status('Choose a supported file up to 100 MB.'); return; }
    generation++; killWorker(); original=null; source=file; backgroundFile=null; maskBuffer=null; clearResult(); resetObjects();
    if ($('background')) { $('background').value=''; $('background-name').textContent=''; $('background-mode').value='color'; $('background-file-options').hidden=true; }
    $('original-wrap').hidden=true; $('info').textContent='';
    window.GWFunnel?.accepted(file.size); setBusy(true); status('Reading your file…');
    const ticket=generation;
    try {
      await ensureWorker(); if(ticket!==generation) return;
      $('original-wrap').hidden=false; $('upload').hidden=true; $('new').hidden=false;
      $('info').textContent=`${file.name} · ${original.width} × ${original.height} · ${original.count} frame${original.count===1?'':'s'}`;
      draw(); status('Describe what to keep, or click the objects to keep, then choose Preview cutout.'); window.GWFunnel?.ready();
    } catch(error) { if(ticket===generation) { original=null; source=null; killWorker(); $('upload').hidden=false; status(error.message); window.GWFunnel?.failure('decode'); } }
    finally { if(ticket===generation) setBusy(false); }
  }
  $('upload').onclick=$('new').onclick=()=>$('file').click();
  $('file').onchange=()=>{load($('file').files[0]); $('file').value='';};
  const stage=document.querySelector('.utility-stage');
  stage.ondragover=event=>{event.preventDefault(); $('upload').classList.add('dragover');};
  stage.ondragleave=()=>$('upload').classList.remove('dragover');
  stage.ondrop=event=>{event.preventDefault(); $('upload').classList.remove('dragover'); load(event.dataTransfer.files[0]);};
  async function api(route,body) {
    const encoded=JSON.stringify(body), raw=new TextEncoder().encode(encoded);
    const digest=await crypto.subtle.digest('SHA-256',raw);
    const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    const response=await fetch('/api/segment/'+route,{method:'POST',headers:{'Content-Type':'application/json','x-amz-content-sha256':hash},body:encoded,signal:AbortSignal.timeout(45000)});
    let result; try { result=await response.json(); } catch(_) { throw Error('Background removal is unavailable. Please try again later.'); }
    if(!response.ok) { const error=Error(result.error || 'Background processing failed.'); error.status=response.status; throw error; } return result;
  }
  async function cancelRemote(run) {
    if(run.submission) { try { await run.submission; } catch(_) {} }
    // Even an interrupted submit may have started compute; cancellation checks
    // its saved server-side reference rather than assuming no job was launched.
    if(!run.submission || !run.job) return;
    for(let i=0;i<12;i++) {
      try { await api('cancel',{job_id:run.job}); return; }
      catch(error) { if(error.status!==409 || i===11) throw error; await new Promise(r=>setTimeout(r,1000)); }
    }
  }
  async function exportResult() {
    const ticket = generation;
    await ensureWorker();
    if (ticket !== generation) throw Error('Processing cancelled.');
    status('Building your result on this device…');
    const span=window.GWFunnel?.exportStarted();
    try {
      const result=await request({type:'export',gif,replace,mode:$('background-mode')?.value || 'color',fit:$('fit')?.value || 'cover',color:$('color')?.value || '#ffffff'});
      if (ticket !== generation) throw Error('Processing cancelled.');
      clearResult(); const blob=new Blob([result.bytes],{type:result.mime}); outputURL=URL.createObjectURL(blob);
      $('result').src=$('download').href=outputURL; $('download').download=source.name.replace(/\.[^.]+$/,'')+'-'+root.dataset.tool+(gif?'.gif':'.png');
      $('download').textContent='Download '+(gif?'GIF':'PNG'); $('download').hidden=$('result-wrap').hidden=false;
      $('segment').textContent='Refine cutout';
      status(describing() ? 'Ready to download. To refine, reword the description, or clear it and click your subject instead.'
        : 'Ready to download. To refine, add keep or exclude points on the original, then preview again.');
      span?.complete();
    } catch(error) { span?.fail('encode'); throw error; }
  }
  $('segment').onclick=async()=>{
    const prompt=describing(), selected=objects.filter(o=>o.points.length);
    if(!prompt) {
      if(!selected.length) { status('Describe what to keep, or choose Keep area and click inside your subject.'); $('prompt').focus(); return; }
      const missing = objects.findIndex(o=>o.points.length && !o.points.some(p=>p.label===1));
      if(missing >= 0) {
        $('object').value=String(missing); $('point-mode').value='1'; selectionMode();
        status($('selection-warning').textContent); $('keep').focus(); return;
      }
    }
    const run=task={cancelled:false,controller:new AbortController()}, ticket=generation;
    clearResult(); maskBuffer=maskPreview=null; $('overlay-wrap').hidden=true; draw(); setBusy(true); const span=window.GWFunnel?.trackingStarted();
    try {
      status(prompt ? 'Uploading source to find what you described…' : 'Uploading source for AI object selection…');
      const issued=await api('presign',{content_type:mime(source)}); run.job=issued.job_id;
      if(run.cancelled) return;
      const upload=await fetch(issued.upload_url,{method:'PUT',headers:{'Content-Type':mime(source)},body:source,signal:AbortSignal.any([run.controller.signal,AbortSignal.timeout(300000)])});
      if(!upload.ok) throw Error('Source upload failed. Try again.');
      if(run.cancelled) return;
      run.submission=api('submit', prompt ? {job_id:run.job,text:prompt} : {job_id:run.job,objects:selected});
      await run.submission;
      const started=Date.now();
      $('progress').removeAttribute('value');
      let result;
      let pollFailures=0;
      while(!run.cancelled) {
        if(Date.now()-started>3700000) throw Error('This job exceeded its processing time. Try a smaller file.');
        try {
          result=await api('status',{job_id:run.job}); pollFailures=0;
        } catch(error) {
          // A transient polling failure must not discard a paid job already running.
          if(run.cancelled) return;
          if((error.status && error.status<500 && error.status!==429) || ++pollFailures>3) throw error;
          status('Connection interrupted. Checking your existing job again…');
          await new Promise(r=>setTimeout(r,2000*pollFailures)); continue;
        }
        if(run.cancelled || ticket!==generation) return;
        if(result.state==='complete') break;
        if(result.state!=='running') throw Error(result.error || 'Segmentation was cancelled.');
        status(`Finding objects in ${original.count} frame${original.count===1?'':'s'}… ${Math.round((Date.now()-started)/1000)}s. You can cancel this job.`);
        await new Promise(r=>setTimeout(r,2000));
      }
      if(run.cancelled || ticket!==generation) return;
      const response=await fetch(result.mask_url,{signal:AbortSignal.any([run.controller.signal,AbortSignal.timeout(120000)])});
      if(!response.ok) throw Error('Could not download the masks. Please try again.');
      const compressed=await response.blob();
      const buffer=await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      if(run.cancelled || ticket!==generation) return;
      await ensureWorker(); const selection=await request({type:'masks',buffer}); maskBuffer=buffer; maskPreview=selection.pixels; $('overlay-wrap').hidden=false; draw(); span?.complete();
      await exportResult();
    } catch(error) {
      span?.fail('processing');
      if(!run.cancelled && ticket===generation) {
        status(error.message);
        if(run.submission) { try { await cancelRemote(run); } catch(_) { status(error.message+' The server job may still be running; it stops after one hour.'); } }
      }
    } finally { if(!run.cancelled && ticket===generation) { task=null; setBusy(false); } }
  };
  async function updatePreview() {
    setBusy(true); clearResult(); const ticket=generation;
    try { await exportResult(); } catch(error) { if(ticket===generation) status(error.message); }
    finally { if(ticket===generation) setBusy(false); }
  }
  $('apply').onclick = updatePreview;
  if(replace) {
    function backgroundChanged() {
      clearResult();
      const needsFile = $('background-mode').value === 'file';
      $('background-file-options').hidden = !needsFile;
      if (needsFile && !backgroundFile) { status('Choose a replacement background file.'); return; }
      if (maskBuffer && !busy) {
        status('Updating preview…');
        previewTimer = setTimeout(updatePreview, 250);
      }
    }
    for(const name of ['background-mode','fit','color']) $(name).oninput=backgroundChanged;
    $('background').onchange=async()=>{
      const file=$('background').files[0]; $('background').value=''; if(!file || busy) return;
      const type=mime(file);
      if(!['image/png','image/jpeg','image/webp',...(gif?['image/gif']:[])].includes(type)||file.size>100*1024*1024) { status('Choose a supported background up to 100 MB.'); return; }
      clearResult(); setBusy(true); const ticket=generation; let decoded=false;
      try {
        await ensureWorker(); const buffer=await file.arrayBuffer(); if(ticket!==generation) return;
        await request({type:'background',buffer,mime:type},[buffer]); backgroundFile=file; decoded=true;
        $('background-name').textContent=file.name; $('background-mode').value='file'; $('background-file-options').hidden=false; status('Background ready. Select your subject and preview the cutout.');
        if (maskBuffer) await exportResult();
      } catch(error) { if(ticket===generation) { if (!decoded) { backgroundFile=null; $('background-name').textContent=''; } status(error.message); } }
      finally { if(ticket===generation) setBusy(false); }
    };
  }
  $('cancel').onclick=async()=>{
    const run=task; if(run) { run.cancelled=true; run.controller.abort(); }
    generation++; clearTimeout(previewTimer); killWorker(); $('cancel').disabled=true; status('Cancelling…');
    try { if(run) await cancelRemote(run); status('Processing cancelled.'); }
    catch(_) { status('Local processing stopped, but server cancellation could not be confirmed. The server job stops after one hour.'); }
    finally { task=null; $('cancel').disabled=false; setBusy(false); }
  };
  window.addEventListener('resize',draw);
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',()=>{killWorker();if(outputURL)URL.revokeObjectURL(outputURL);});
})();
