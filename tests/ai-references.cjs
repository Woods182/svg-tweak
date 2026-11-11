// Run: node tests/ai-references.cjs (synthetic images and in-page mock API only).
const assert = require('node:assert/strict');
const {withEditor} = require('./browser.cjs');

const FIXTURE = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect id="box" x="20" y="30" width="120" height="70" fill="#628db1"/><text x="25" y="65">Keep this text</text></svg>';

async function main() {
  const passed = [];
  await withEditor(async ({evalJS,delay}) => {
    const page = (fn,...args) => evalJS('('+fn.toString()+')(...'+JSON.stringify(args)+')');
    async function waitFor(expression,label) {
      for (let i=0;i<100;i++) {
        if (await evalJS(expression)) return;
        await delay(30);
      }
      throw new Error('Timed out: '+label);
    }
    assert.equal(await page(()=>typeof aiAddReferenceFiles==='function' && typeof aiRemoveReference==='function'),true,'reference attachment API is available');
    await page(xml=>{
      loadSVGText(xml,'reference-test.svg');select([doc.querySelector('#box')]);aiToggle(true);
      $('aiBaseURL').value='https://reference.invalid/v1';$('aiModel').value='reference-mock';$('aiKey').value='reference-dummy-key';
      $('aiVision').checked=false;$('aiScope').value='selection';
      window.confirm=()=>true;
      window.__referenceRequests=[];
      window.__makeReference=async(name,color,width=80,height=45,type='image/png')=>{
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,width,height);
        context.strokeStyle='#122334';context.lineWidth=2;context.strokeRect(4,4,width-8,height-8);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,type,.92));
        return new File([blob],name,{type:blob.type});
      };
      window.fetch=async(url,options)=>{
        if(url!=='https://reference.invalid/v1/chat/completions')throw new Error('Unexpected mock URL');
        const body=JSON.parse(options.body);__referenceRequests.push(body);
        const message=body.messages.at(-1),text=typeof message.content==='string'?message.content:message.content[0].text;
        let payload;try{payload=JSON.parse(text);}catch(_){}
        const index=__referenceRequests.length;
        const svg=payload?.document && new DOMParser().parseFromString(payload.document.xml,'image/svg+xml');
        const plan=svg?{summary:'Reference result '+index,operations:[{op:'style',targets:[svg.querySelector('#box').getAttribute('data-ai-key')],properties:{fill:index%2?'#538f6b':'#ad723f'}}]}:'OK';
        const response=()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:typeof plan==='string'?plan:JSON.stringify(plan)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
        if(window.__holdReferenceRequest){
          return await new Promise((resolve,reject)=>{
            window.__releaseReferenceRequest=()=>resolve(response());
            options.signal.addEventListener('abort',()=>reject(new DOMException('mock canceled','AbortError')),{once:true});
          });
        }
        return response();
      };
    },FIXTURE);
    const canvasState=()=>page(()=>({xml:snapshot(),undo:state.undo.slice(),redo:state.redo.slice(),dirty:state.dirty,selection:[...state.sel].map(nodePathOf)}));
    const references=()=>page(()=>({ids:aiState.referenceIds.slice(),size:aiState.referenceAssets.size,reading:aiState.readingReferences}));
    const original=await canvasState();
    const originalControls=await page(()=>({multiple:$('aiReferenceInput').multiple,accept:$('aiReferenceInput').accept}));
    assert.equal(originalControls.multiple,true);assert.match(originalControls.accept,/png/);assert.match(originalControls.accept,/jpeg|jpg/);assert.match(originalControls.accept,/webp/);

    await page(async()=>{
      window.__firstReference=await __makeReference('中文 <reference>.png','#e8ddae');
      const transfer=new DataTransfer();transfer.items.add(__firstReference);
      $('aiReferenceInput').files=transfer.files;$('aiReferenceInput').dispatchEvent(new Event('change',{bubbles:true}));
    });
    await waitFor('!aiState.readingReferences && aiState.referenceIds.length===1','file input attachment');
    const first=await references();
    assert.equal(first.size,1);assert.deepEqual(await canvasState(),original,'attaching a reference never inserts an image, clears selection, or adds undo history');
    assert.deepEqual(await page(()=>{
      const asset=aiState.referenceAssets.get(aiState.referenceIds[0]);
      return {width:asset.width,height:asset.height,name:asset.name,bitmap:/^data:image\/(png|jpeg|webp);base64,/.test(asset.dataURL),rendered:$('aiReferences').querySelector('img')?.src===asset.dataURL};
    }),{width:80,height:45,name:'中文 <reference>.png',bitmap:true,rendered:true});
    await page(async()=>{await aiAddReferenceFiles([__firstReference]);});
    assert.deepEqual(await references(),first,'re-adding an identical image uses the same asset and attachment');
    await page(async()=>{
      window.__wideReference=await __makeReference('wide.jpg','#a5cedf',4096,1024,'image/jpeg');
      await aiAddReferenceFiles([__wideReference]);
    });
    assert.deepEqual(await page(()=>{
      const asset=aiState.referenceAssets.get(aiState.referenceIds[1]);return [asset.width,asset.height];
    }),[2048,512],'large references are resized without changing aspect ratio');

    const paste=await page(async()=>{
      const transfer=new DataTransfer();transfer.items.add(await __makeReference('paste.webp','#d1a5d7',90,55,'image/webp'));
      const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});
      $('aiPrompt').dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(paste,true,'pasting an image in the AI input consumes the reference paste');
    await waitFor('!aiState.readingReferences && aiState.referenceIds.length===3','pasted reference');
    const plainPaste=await page(()=>{
      const transfer=new DataTransfer();transfer.setData('text/plain','keep native text paste');
      const event=new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true});
      $('aiPrompt').dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(plainPaste,false,'ordinary text paste remains native');
    const drop=await page(async()=>{
      window.__fourthReference=await __makeReference('drop.png','#9ac2a2',65,65);
      const transfer=new DataTransfer();transfer.items.add(__fourthReference);
      const event=new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true});
      $('aiComposer').dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(drop,true);await waitFor('!aiState.readingReferences && aiState.referenceIds.length===4','dropped reference');
    assert.deepEqual(await canvasState(),original,'AI paste and drop must not reach the canvas import handlers');
    passed.push('file input, JPEG resizing, WebP paste and PNG drop; lossless asset reuse; no canvas/selection/undo mutation');

    await page(()=>$('aiReferences').querySelector('img').closest('button').click());
    assert.equal(await page(()=>$('aiReferenceViewer').open),true,'thumbnail opens an image viewer');
    assert.equal(await page(()=>$('aiReferenceImage').src===aiState.referenceAssets.get(aiState.referenceIds[0]).dataURL),true);
    await page(()=>$('aiReferenceClose').click());
    assert.equal(await page(()=>$('aiReferenceViewer').open),false);
    const stableRefs=await references();
    await page(()=>setUILanguage('en'));
    const english=await page(()=>({button:$('aiAddReference').textContent,hint:$('aiReferenceHint').textContent}));
    for(const value of Object.values(english)){assert.ok(value.trim());assert.doesNotMatch(value,/[\u3400-\u9fff]/);}
    assert.deepEqual(await references(),stableRefs);assert.deepEqual(await canvasState(),original);
    await page(()=>setUILanguage('zh-CN'));
    assert.deepEqual(await references(),stableRefs,'switching languages keeps reference assets/IDs intact');
    passed.push('click-to-view references and bilingual controls preserve SVG and attachment state');

    async function generate(prompt='Reference only the drawing style') {
      const before=await page(()=>({requests:__referenceRequests.length,versions:aiState.versions.length}));
      await page(async prompt=>{$('aiPrompt').value=prompt;await aiSend();},prompt);
      const result=await page(()=>({body:__referenceRequests.at(-1),requests:__referenceRequests.length,versions:aiState.versions.length,version:aiState.pending?.id,status:$('aiStatus').textContent,refs:aiState.messages.filter(m=>m.role==='user').at(-1)?.referenceIds}));
      assert.equal(result.requests,before.requests+1,result.status);
      assert.equal(result.versions,before.versions+1,result.status);
      assert.equal(typeof result.version,'number',result.status);
      const content=result.body.messages.at(-1).content;
      result.payload=JSON.parse(typeof content==='string'?content:content[0].text);
      result.images=Array.isArray(content)?content.filter(part=>part.type==='image_url').map(part=>part.image_url.url):[];
      return result;
    }
    const firstGeneration=await generate();
    const attachedIds=stableRefs.ids;
    assert.deepEqual(firstGeneration.refs,attachedIds,'user messages snapshot reference IDs, not a mutable composer array');
    assert.equal(firstGeneration.payload.references.length,4);
    assert.deepEqual(firstGeneration.payload.references.map(ref=>ref.imageOrder),[1,2,3,4]);
    assert.deepEqual(firstGeneration.images,await page(()=>aiState.referenceIds.map(id=>aiState.referenceAssets.get(id).dataURL)),'reference image order matches the visible thumbnail order, even with canvas screenshots disabled');
    assert.deepEqual(firstGeneration.payload.references.map(ref=>ref.number),[1,2,3,4]);
    assert.match(firstGeneration.payload.references[0].name,/中文 <reference>/);
    assert.equal(firstGeneration.payload.canvasScreenshot,undefined);
    assert.deepEqual(await canvasState(),original,'AI reference generation remains preview-only');
    assert.deepEqual(await references(),stableRefs,'generating retains attachments for repeated variations');
    assert.equal(await page(()=>JSON.stringify(aiState.messages).includes('data:image/')),false,'messages contain reference IDs, never their own image copies');
    const secondGeneration=await generate();
    assert.equal(secondGeneration.payload.variation.previous.length,1,'same prompt, base and references can generate another variation');
    assert.equal((await references()).size,4,'successive candidates do not copy image assets');
    const fourthId=attachedIds[3];
    await page(id=>aiRemoveReference(id),fourthId);
    assert.deepEqual((await references()).ids,attachedIds.slice(0,3));
    assert.equal((await references()).size,4,'removing a sent image from the composer retains it for old messages');
    assert.deepEqual(await page(()=>aiState.messages.find(m=>m.role==='user').referenceIds),attachedIds,'old message attachment lists do not change');
    assert.equal(await page(()=>[...$('aiMessages').querySelectorAll('.aiMessage.user img')].some(img=>img.src===aiState.referenceAssets.get(aiState.messages.find(m=>m.role==='user').referenceIds[3]).dataURL)),true,'old user messages retain their reference thumbnails');
    const changedReferences=await generate();
    assert.equal(changedReferences.payload.variation,undefined,'different attached images must not be grouped with same-reference variations');
    await page(async()=>{await aiAddReferenceFiles([__fourthReference]);});
    assert.deepEqual(await references(),stableRefs,'reattaching a sent reference reuses its existing asset ID');
    await page(()=>$('aiVision').checked=true);
    const withScreenshot=await generate();
    assert.equal(withScreenshot.images.length,5);
    assert.deepEqual(withScreenshot.payload.canvasScreenshot,{imageOrder:1});
    assert.deepEqual(withScreenshot.payload.references.map(ref=>ref.imageOrder),[2,3,4,5],'the model can distinguish the canvas screenshot from each numbered reference');
    assert.deepEqual(withScreenshot.images.slice(1),firstGeneration.images);
    passed.push('labeled multimodal payloads, optional canvas screenshot, independent reference input, reusable variations and immutable chat attachment records');

    await page(id=>{aiAdoptVersion(id);$('aiVision').checked=false;for(const reference of [...aiState.referenceIds])aiRemoveReference(reference);},firstGeneration.version);
    const noReferences=await generate('Continue this version without reference pictures');
    assert.equal(noReferences.images.length,0,'removing the current references prevents old chat images from being uploaded automatically');
    assert.equal(noReferences.payload.references,undefined);
    assert(noReferences.body.messages.slice(1,-1).length>0,'continuing an applied version includes relevant text history');
    for(const message of noReferences.body.messages.slice(1,-1)){
      assert.equal(typeof message.content,'string','image history is explicitly textual, not repeated image bodies');
      assert.doesNotMatch(message.content,/data:image\//);
    }
    await page(async()=>{await aiAddReferenceFiles([__firstReference]);await aiTestConnection();});
    const connection=await page(()=>__referenceRequests.at(-1));
    assert.equal(connection.messages.length,1);assert.equal(typeof connection.messages[0].content,'string');
    assert.doesNotMatch(connection.messages[0].content,/data:image|<svg/i,'connection check never sends references, SVGs, or chat history');

    await page(()=>{window.__holdReferenceRequest=true;$('aiPrompt').value='Hold this request';window.__heldReferencePromise=aiSend();});
    await waitFor('typeof window.__releaseReferenceRequest==="function"','held mock request');
    const busyReferences=await references();
    assert.equal(await page(()=>$('aiAddReference').disabled),true);
    await page(async()=>{aiRemoveReference(aiState.referenceIds[0]);await aiAddReferenceFiles([__fourthReference]);});
    assert.deepEqual(await references(),busyReferences,'attachment edits cannot race with an active generation');
    await page(async()=>{__releaseReferenceRequest();await __heldReferencePromise;window.__holdReferenceRequest=false;});
    passed.push('only current reference pixels are transmitted; text-only history/connection checks; in-flight attachments remain stable');

    await page(()=>{aiResetDocument();});
    assert.deepEqual(await references(),{ids:[],size:0,reading:false},'new chat releases current and historical image assets');
    const validationCanvas=await canvasState();
    async function rejectedFile(make,label) {
      const before=await references();
      await page(async source=>{const file=await (0,eval)('('+source+')')();await aiAddReferenceFiles([file]);},make.toString());
      assert.deepEqual(await references(),before,label+' preserves current references');
      assert.equal(await page(()=>$('aiStatus').classList.contains('error')),true,label+' is explained in the status');
      assert.deepEqual(await canvasState(),validationCanvas,label+' leaves the canvas unchanged');
    }
    await rejectedFile(()=>new File(['<svg/>'],'not-a-reference.svg',{type:'image/svg+xml'}),'unsupported format');
    await rejectedFile(()=>new File(['not a valid PNG'],'broken.png',{type:'image/png'}),'image decode error');
    await rejectedFile(async()=>{const file=await __makeReference('too-large.png','#aabbcc');Object.defineProperty(file,'size',{value:AI_REFERENCE_FILE_BYTES+1});return file;},'source file size limit');
    await page(async()=>{await aiAddReferenceFiles(await Promise.all(Array.from({length:AI_REFERENCE_LIMIT+1},(_,i)=>__makeReference('count-'+i+'.png','rgb('+i+',80,100)'))));});
    assert.deepEqual(await references(),{ids:[],size:0,reading:false},'too many references cannot partially attach a batch');
    assert.equal(await page(()=>$('aiStatus').classList.contains('error')),true);
    await page(async()=>{
      await aiAddReferenceFiles([__firstReference]);
      const asset=aiState.referenceAssets.get(aiState.referenceIds[0]);
      asset.dataURL+=' '.repeat(Math.ceil(AI_REFERENCE_BYTES/2));
      window.__budgetReferenceId=asset.id;
      await aiAddReferenceFiles([__fourthReference]);
    });
    assert.deepEqual((await references()).ids,await page(()=>[__budgetReferenceId]),'session memory budget rejects additional assets without partial changes');
    assert.equal((await references()).size,1);assert.equal(await page(()=>$('aiStatus').classList.contains('error')),true);
    await page(()=>aiResetDocument());
    passed.push('format, decode, file-size, count and session-memory limits reject cleanly without touching the diagram');

    await page(()=>{
      window.__originalReferenceDecode=window.createImageBitmap;
      window.createImageBitmap=(...args)=>new Promise((resolve,reject)=>{
        window.__releaseReferenceDecode=()=>__originalReferenceDecode(...args).then(resolve,reject);
      });
      window.__pendingReferenceDecode=aiAddReferenceFiles([__firstReference]);
    });
    await waitFor('aiState.readingReferences && typeof window.__releaseReferenceDecode==="function"','pending reference decode');
    assert.equal(await page(()=>$('aiSend').disabled),true,'generation waits for image preparation');
    await page(()=>aiResetDocument());
    await page(async()=>{try{__releaseReferenceDecode();await __pendingReferenceDecode;}finally{window.createImageBitmap=__originalReferenceDecode;}});
    assert.deepEqual(await references(),{ids:[],size:0,reading:false},'decoding a file from a cleared chat cannot attach it to the new chat');
    await page(async()=>{await aiAddReferenceFiles([__firstReference]);loadSVGText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="3"/></svg>','another.svg');});
    assert.deepEqual(await references(),{ids:[],size:0,reading:false},'opening another diagram clears reference state');
    assert.deepEqual(await page(()=>window.__auditErrors),[],'no uncaught browser errors or unhandled promises');
    passed.push('reset during decoding, generation blocking while loading, and new-document cleanup');
  });
  console.log('PASS: '+passed.join('; ')+'.');
}

main().catch(error=>{console.error(error);process.exitCode=1;});
