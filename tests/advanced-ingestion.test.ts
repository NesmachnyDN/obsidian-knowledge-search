import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { canonical, canonicalFrame, decodeFrame, INGEST_VERSION,
  IngestError, parseIngestFrame, sha, validRequest, validateReply,
  MAX_RESPONSE, MAX_REQUEST, type IngestRequest, type IngestResponse } from '../plugin/src/advanced/protocol';
import { verifyProvenance } from '../plugin/src/advanced/provenance';
import { defaultSettings, parseSettings } from '../plugin/src/search/settings';
import { selectProfile, AdvancedIngestionManager } from '../plugin/src/advanced/manager';

type Fixture={name:string;rawBase64:string;request:IngestRequest;response:IngestResponse};
const registry: {schema:string;cases:Fixture[]} = JSON.parse(readFileSync('contracts/fixtures/advanced-ingestion-v1.json','utf8'));
const fixtures=registry.cases;
const clone=<T>(v:T):T=>structuredClone(v);
const strict=(v:unknown):void=>{assert.throws(()=>v);};
const rejected=(f:()=>void,code='ADVANCED_PROTOCOL_INVALID')=>{
  assert.throws(f,(error:unknown)=>error instanceof IngestError && error.code===code);
};

test('cross-language v3 canonical wire accepts pinned Markdown, PDF and DOCX fixtures',()=>{
  assert.equal(INGEST_VERSION,3);
  assert.equal(fixtures.length,3);
  for(const entry of fixtures) {
    validRequest(entry.request);
    const wire=canonicalFrame(entry.response,MAX_RESPONSE);
    const parsed=parseIngestFrame(wire,entry.request);
    assert.deepEqual(parsed,entry.response);
    assert.deepEqual(decodeFrame(wire,MAX_RESPONSE),entry.response);
    const raw=Buffer.from(entry.rawBase64,'base64');
    assert.equal(sha(raw),entry.request.expectedSha256);
    verifyProvenance(parsed,raw);
    assert.equal(parsed.source?.scopeId,entry.request.scopeId);
    assert.equal(parsed.source?.sourceId,entry.request.sourcePath);
    assert.equal(parsed.generationId?.length,64);
    if(entry.name.endsWith('.md')){
      const properties=parsed.source!.properties;
      assert.deepEqual(properties.map(p=>[p.key,p.valueType]),[
        ['version','number'],['active','boolean'],['tags','list'],['created','date']]);
      assert.deepEqual(properties.find(p=>p.key==='tags')?.value,['1',1,true,null]);
      assert.equal(parsed.source!.blocks[6]?.locator.locatorKind,'markdown');
      assert.equal(parsed.source!.blocks[6]?.originalText,'# Раздел 🚀');
      assert.equal(parsed.source!.blocks[9]?.wikiLinks[0],'linked|Alias');
      assert.equal(parsed.status,'ok');
    } else {
      assert.equal(parsed.status,'partial');
      for(const block of parsed.source!.blocks){
        assert.notEqual(block.locator.locatorKind,'markdown');
        assert.equal(block.locator.byteStart,null);
        assert.equal(block.locator.byteEnd,null);
      }
    }
  }
});
test('v3 Python/TypeScript bidirectional numeric and Unicode canonical byte parity',()=>{
  // Frozen edge values plus a cross-process comparison prevent shared fixture
  // blind spots: the Python producer and TS consumer must agree on exact bytes.
  const samples: unknown[]=[
    {bbox:[1e-7,0,1,1],property:1e-7},
    {values:[1e-6,9e-7,1e20,1e21,5e-324,-0,1.2345e-6]},
    {limits:[Number.MAX_SAFE_INTEGER,9007199254740992,1.7976931348623157e308]},
    {'\uE000':'bmp','😀':'supplementary',nested:{'😀':1e-7,'\uE000':1e21}},
    {negative:-0.0000001,large:1000000000000000100,unicode:'Договор 🚀'},
  ];
  const pythonScript=[
    'import sys,json',
    'sys.path.insert(0,".")',
    'from engine.advanced_protocol import encode,decode,MAX_RESPONSE',
    'value=json.load(sys.stdin)',
    'out=encode(value)',
    'assert decode(out,MAX_RESPONSE)==value',
    'sys.stdout.buffer.write(out)',
  ].join(';');
  for(const sample of samples){
    const ts=canonicalFrame(sample,MAX_RESPONSE);
    const producer=spawnSync('python3',['-I','-B','-c',pythonScript],{
      input:Buffer.from(JSON.stringify(sample),'utf8'),timeout:5000,
    });
    assert.equal(producer.status,0,producer.stderr?.toString());
    assert.deepEqual(producer.stdout,ts,'Python and TS must emit identical bytes');
    assert.deepEqual(decodeFrame(producer.stdout,MAX_RESPONSE),JSON.parse(JSON.stringify(sample)));
  }
  assert.equal(canonicalFrame({bbox:[1e-7,0,1,1]},MAX_RESPONSE).toString(),
    '{"bbox":[1e-7,0,1,1]}\n');
  assert.equal(canonical({'\uE000':'bmp','😀':'supplementary'}),
    '{"\uE000":"bmp","😀":"supplementary"}');
  rejected(()=>canonicalFrame({invalid:'\ud800'},MAX_REQUEST));
});

test('Python and TypeScript framing cannot ambiguously parse duplicate fields, BOM, invalid UTF-8, junk or oversize',()=>{
  const {request,response}=fixtures[0]!;
  const base=canonicalFrame(response,MAX_RESPONSE).toString('utf8');
  rejected(()=>decodeFrame(Buffer.from(base.replace('"protocolVersion":3',
    '"protocolVersion":3,"protocolVersion":3')),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(base)]),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.from([0xff,10]),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.from(base+'\n'),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.from(base+'x'),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.alloc(MAX_RESPONSE+1),MAX_RESPONSE));
  rejected(()=>decodeFrame(Buffer.from('{ "a":1}\n'),MAX_REQUEST));
  rejected(()=>canonicalFrame({a:NaN},MAX_REQUEST));
  const bad=clone(request) as unknown as Record<string,unknown>;
  bad.protocolVersion=2;
  rejected(()=>validRequest(bad));
  bad.protocolVersion=3; bad.sourcePath='../outside.pdf';
  rejected(()=>validRequest(bad));
  bad.sourcePath='x.md';bad.requestId='client-forged';
  rejected(()=>validRequest(bad));
  bad.requestId='b'.repeat(48); bad.profileId='https://example.invalid';
  rejected(()=>validRequest(bad));
});
test('forged request correlation, generation, typed Properties, source identity and unknown versions refuse response',()=>{
  const {response,request}=fixtures[0]!;
  const change=(fn:(r:IngestResponse)=>void)=>()=>{
    const copy=clone(response);fn(copy);parseIngestFrame(canonicalFrame(copy,MAX_RESPONSE),request);
  };
  rejected(change(r=>{r.requestId='c'.repeat(48);}));
  rejected(change(r=>{r.protocolVersion=2 as 3;}));
  rejected(change(r=>{r.generationId='0'.repeat(64);}));
  rejected(change(r=>{r.source!.sha256='0'.repeat(64);}));
  rejected(change(r=>{r.source!.extractionStatus='partial';}));
  rejected(change(r=>{r.source!.properties[0]!.valueType='string';}));
  rejected(change(r=>{r.chunks[0]!.originalText='context-only fabricated evidence';}));
  rejected(change(r=>{r.source!.blocks[0]!.locator.locatorKind='native';}));
  rejected(change(r=>{(r as unknown as Record<string,unknown>).unknown='injected';}));
});
test('reverified source coordinates detect forged Markdown byte/Unicode/line offsets and chunk locators',()=>{
  const {response,request,rawBase64}=fixtures[0]!;
  const bytes=Buffer.from(rawBase64,'base64');
  const damage=(fn:(r:IngestResponse)=>void)=>{
    const fake=clone(response);fn(fake);
    rejected(()=>{
      const parsed=parseIngestFrame(canonicalFrame(fake,MAX_RESPONSE),request);
      verifyProvenance(parsed,bytes);
    });
  };
  damage(r=>{r.source!.blocks[6]!.locator.byteStart!+=1;});
  damage(r=>{r.source!.blocks[6]!.locator.charStart!+=1;});
  damage(r=>{r.source!.blocks[6]!.locator.lineStart!+=1;});
  damage(r=>{r.source!.blocks[6]!.blockId='f'.repeat(64);});
  damage(r=>{r.chunks[0]!.sourceLocators[0]!.byteStart!+=1;});
  damage(r=>{r.source!.blocks[6]!.originalText='NOT in original';});
  const changed=Buffer.from(bytes);changed[0]=64;
  rejected(()=>verifyProvenance(response,changed));
});
test('native locators have bounded pages/geometry; forged native coordinates refuse evidence',()=>{
  const {response,request,rawBase64}=fixtures[1]!;
  const bytes=Buffer.from(rawBase64,'base64');
  const damage=(fn:(r:IngestResponse)=>void)=>{
    const fake=clone(response);fn(fake);
    rejected(()=>{
      const parsed=parseIngestFrame(canonicalFrame(fake,MAX_RESPONSE),request);
      verifyProvenance(parsed,bytes);
    });
  };
  damage(r=>{r.source!.blocks[0]!.locator.locations[0]!.page=99;});
  damage(r=>{r.source!.blocks[0]!.locator.locations[0]!.bbox[0]=-1;});
  damage(r=>{r.source!.blocks[0]!.locator.locations[0]!.bbox[0]=8000;});
  damage(r=>{r.chunks[0]!.sourceLocators[0]!.nativeItemRef='#/forged';});
  damage(r=>{r.source!.blocks[0]!.locator.locations[0]!.coordinateOrigin='UNKNOWN';});
  const docx=fixtures[2]!;
  const verified=parseIngestFrame(canonicalFrame(docx.response,MAX_RESPONSE),docx.request);
  const cell=verified.source!.blocks[0]!.cells[1]!;
  assert.equal(cell.originalText,'Б');
  assert.deepEqual(cell.locator.colRange,[1,2]);
  assert.equal(cell.locator.nativeItemRef,verified.source!.blocks[0]!.locator.nativeItemRef);
});
test('native table cell schema rejects forged or incoherent geometry, origins and ranges',()=>{
  const fixture=fixtures.find(entry=>entry.name==='table.docx')!;
  const raw=Buffer.from(fixture.rawBase64,'base64');
  const damage=(mutate:(response:IngestResponse)=>void)=>{
    const fake=clone(fixture.response);
    mutate(fake);
    rejected(()=>{
      const checked=parseIngestFrame(canonicalFrame(fake,MAX_RESPONSE),fixture.request);
      verifyProvenance(checked,raw);
    });
  };
  const cell=(r:IngestResponse)=>r.source!.blocks[0]!.cells[1]!.locator;
  damage(r=>{cell(r).cellCoordinateOrigin='INVALID';});
  damage(r=>{cell(r).cellCoordinateOrigin='TOPLEFT';}); // no bbox
  damage(r=>{cell(r).cellBBox=[5,5,10,10];cell(r).cellCoordinateOrigin='INVALID';});
  damage(r=>{cell(r).cellBBox=[5,5,10,10];}); // no coordinate origin
  damage(r=>{cell(r).cellBBox=[5,5,10,10];cell(r).cellCoordinateOrigin='TOPLEFT';cell(r).rowRange=[1,1];});
  damage(r=>{cell(r).cellBBox=[5,5,10,10];cell(r).cellCoordinateOrigin='TOPLEFT';cell(r).colRange=[2,1];});
  damage(r=>{cell(r).cellBBox=[5,10,4,12];cell(r).cellCoordinateOrigin='BOTTOMLEFT';});
  damage(r=>{cell(r).cellBBox=[5,-1,10,12];cell(r).cellCoordinateOrigin='BOTTOMLEFT';});
  damage(r=>{cell(r).cellBBox=[5,5,2001,10];cell(r).cellCoordinateOrigin='TOPLEFT';});
  const good=clone(fixture.response);
  cell(good).cellBBox=[5,5,10,10];
  cell(good).cellCoordinateOrigin='TOPLEFT';
  const checked=parseIngestFrame(canonicalFrame(good,MAX_RESPONSE),fixture.request);
  verifyProvenance(checked,raw);
});

test('explicit ingestion configuration defaults disabled and old versions never silently enable it',()=>{
  assert.equal(defaultSettings().version,4);
  assert.equal(defaultSettings().ingestion.enabled,false);
  assert.equal(parseSettings(null).ingestion.enabled,false);
  for(const version of [2,3]){
    const legacy=clone(defaultSettings()) as unknown as Record<string,unknown>;
    delete legacy.ingestion;legacy.version=version;
    if(version===2) legacy.advanced={enabled:false,profile:'none'};
    assert.equal(parseSettings(legacy).ingestion.enabled,false);
    legacy.ingestion={...defaultSettings().ingestion,enabled:true};
    assert.throws(()=>parseSettings(legacy));
  }
  const invalid=clone(defaultSettings());
  invalid.ingestion.enabled=true;
  assert.throws(()=>parseSettings(invalid));
  const correct=clone(defaultSettings());
  correct.ingestion={enabled:true,interpreter:'/usr/bin/python3.12',
    entry:'/app/advanced_ingest.py',tokenizerSnapshot:'/pinned',
    tessdataPath:'',artifactsPath:'',pdfMode:'text'};
  assert.deepEqual(parseSettings(correct).ingestion,correct.ingestion);
});
test('profiles never silently choose OCR and dense/hybrid are not ingestion operations',()=>{
  assert.equal(selectProfile('p.MD','text'),'oks-advanced-markdown-v1');
  assert.equal(selectProfile('a.pdf','text'),'docling-native-pdf-2.151.1');
  assert.equal(selectProfile('a.pdf','ocr'),'tesseract-cli-5.3.4-eng-rus');
  assert.equal(selectProfile('a.docx','text'),'docling-docx-2.151.1');
  rejected(()=>selectProfile('invalid.exe','text'),'SOURCE_REJECTED');
});
test('disabled ingestion refuses starting external backend without any filesystem/model access',async()=>{
  const instance=new AdvancedIngestionManager();
  try {
    await assert.rejects(instance.ingest(defaultSettings().ingestion,'/invalid','oks-synthetic-evidence',
      'x.md',()=>true),(e:unknown)=>e instanceof IngestError && e.code==='ADVANCED_UNAVAILABLE');
  } finally {await instance.dispose();}
});

test('descriptor-anchored TS source read denies parent symlink escape, file symlink, and changed/deleted source',async()=>{
  const {mkdtemp,mkdir,writeFile,symlink,rename,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {readSource,trustedVaultRoot}=await import('../plugin/src/advanced/source');
  const temp=await mkdtemp(join(tmpdir(),'oks05c-scope-'));
  const root=join(temp,'root');const outside=join(temp,'secret');
  try {
    await mkdir(root);await mkdir(outside);await mkdir(join(root,'folder'));
    await writeFile(join(outside,'payload.md'),'private outside');
    await writeFile(join(root,'folder','payload.md'),'synthetic inside');
    await symlink(outside,join(root,'escape'));
    await symlink(join(outside,'payload.md'),join(root,'secret.md'));
    const identity=await trustedVaultRoot(root);
    await assert.rejects(readSource(identity,'escape/payload.md'));
    await assert.rejects(readSource(identity,'secret.md'));
    await assert.rejects(readSource(identity,'../secret/payload.md'));
    const original=await readSource(identity,'folder/payload.md');
    assert.equal(Buffer.from(original.bytes).toString(),'synthetic inside');
    await rename(join(root,'folder'),join(root,'old-folder'));
    await symlink(outside,join(root,'folder'));
    await assert.rejects(readSource(identity,'folder/payload.md'));
    await rm(join(root,'folder'));
    await assert.rejects(readSource(identity,'folder/payload.md'));
    assert.equal((await readSource(identity,'old-folder/payload.md')).sha256,original.sha256);
  } finally {await rm(temp,{recursive:true,force:true});}
});
