/** Independently validate backend-reported provenance against verified raw source bytes. */
import { canonical, IngestError, sha, type IngestLocator, type IngestResponse } from './protocol';

function invalid():never { throw new IngestError('ADVANCED_PROTOCOL_INVALID'); }
type Boundary={char:number;line:number};
export function verifyProvenance(reply: IngestResponse,raw:Uint8Array):void {
  const source=reply.source;
  if (source===null) {
    if (reply.chunks.length) invalid();
    return;
  }
  if (sha(raw)!==source.sha256 || source.extractionStatus!==reply.status) invalid();
  const md=source.sourceType==='markdown';
  const positions=new Map<number,Boundary>();
  if (md) {
    let decoded:string;
    try { decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw); }
    catch {invalid();}
    if (decoded.startsWith('\ufeff') || decoded.includes('\0')) invalid();
    let offset=0, chars=0, line=1, prev='';
    positions.set(0,{char:0,line:1});
    for(const cp of decoded) {
      offset+=Buffer.byteLength(cp);
      chars++;
      if(cp==='\r'||cp==='\n'&&prev!=='\r') line++;
      positions.set(offset,{char:chars,line});
      prev=cp;
    }
    if(offset!==raw.byteLength) invalid();
  }
  const verifyLocation=(loc:IngestLocator,original:string,kind:'block'|'cell'):void=>{
    if (loc.sourceVersion!==source.sha256) invalid();
    if (md) {
      if (loc.locatorKind!=='markdown' || loc.byteStart===null || loc.byteEnd===null
          || loc.charStart===null || loc.charEnd===null
          || loc.lineStart===null || loc.lineEnd===null
          || loc.byteEnd>raw.byteLength || loc.byteStart>loc.byteEnd) invalid();
      const start=positions.get(loc.byteStart), end=positions.get(loc.byteEnd);
      if(!start||!end||start.char!==loc.charStart||end.char!==loc.charEnd
          ||start.line!==loc.lineStart||end.line!==loc.lineEnd
          ||loc.lineStart!==loc.lineEnd) invalid();
      let slice:string;
      try {slice=new TextDecoder('utf-8',{fatal:true})
        .decode(raw.subarray(loc.byteStart,loc.byteEnd));}
      catch {invalid();}
      if(slice!==original) invalid();
    } else {
      // PDF/DOCX original bytes are *never* text offsets.
      if(loc.locatorKind==='markdown' || loc.byteStart!==null || loc.byteEnd!==null
          || loc.charStart!==null || loc.charEnd!==null
          || loc.lineStart!==null || loc.lineEnd!==null) invalid();
      if(loc.locatorKind==='native'){
        if(!loc.nativeItemRef || !loc.nativeRepresentation || !loc.contentLayer) invalid();
        for(const location of loc.locations) {
          if(!Number.isInteger(location.page) || location.page<1
            || source.pageCount!==null && location.page>source.pageCount) invalid();
          const [left,top,right,bottom]=location.bbox;
          if(left===undefined||top===undefined||right===undefined||bottom===undefined
            ||[left,top,right,bottom].some(x=>!Number.isFinite(x)||x<0||x>2000)
            ||left>right || (location.coordinateOrigin!=='TOPLEFT'
              && location.coordinateOrigin!=='BOTTOMLEFT')) invalid();
          if(location.charStart!==null && location.charEnd!==null
            && location.charEnd>Array.from(original).length
            && kind==='block' && !loc.diagnostics.includes('native-text-not-verbatim')) invalid();
        }
        if(kind==='cell' && loc.cellBBox){
          const [left,top,right,bottom]=loc.cellBBox;
          if(left===undefined||top===undefined||right===undefined||bottom===undefined
            ||[left,top,right,bottom].some(x=>!Number.isFinite(x)||x<0||x>2000)
            ||left>right||!loc.rowRange||!loc.colRange
            ||loc.rowRange[1]!<=loc.rowRange[0]!
            ||loc.colRange[1]!<=loc.colRange[0]!) invalid();
        }
      }
      if(loc.locatorKind==='unavailable' && !loc.diagnostics.length) invalid();
    }
  };
  for(const [index,block] of source.blocks.entries()){
    if(block.order!==index || block.locator.blockOrder!==index
      ||block.blockId!==sha(canonical([source.sha256,source.profileId,index,block.kind,block.originalText])))
      invalid();
    verifyLocation(block.locator,block.originalText,'block');
    for(const cell of block.cells){
      if(cell.locator.blockOrder!==index) invalid();
      verifyLocation(cell.locator,cell.originalText,'cell');
      if(!md && block.locator.nativeItemRef && cell.locator.nativeItemRef!==block.locator.nativeItemRef)
        invalid();
    }
    if(!md && block.textNature==='table-cell-serialization' && block.cells.length===0) invalid();
    if(!md && block.locator.locatorKind==='unavailable' && block.originalText.trim()
      && reply.status==='ok') invalid();
  }
  for(const chunk of reply.chunks){
    for(const [index,slice] of chunk.sourceSlices.entries()){
      const block=source.blocks[slice.blockOrder], loc=chunk.sourceLocators[index];
      if(!block||!loc||loc.blockOrder!==slice.blockOrder) invalid();
      if(md){
        const prefix=Array.from(block.originalText).slice(0,slice.charStart).join('');
        const fragment=Array.from(block.originalText).slice(slice.charStart,slice.charEnd).join('');
        const base=block.locator;
        if(base.byteStart===null||base.charStart===null) invalid();
        verifyLocation(loc,fragment,'block');
        if(loc.byteStart!==base.byteStart+Buffer.byteLength(prefix)
          ||loc.byteEnd!==base.byteStart+Buffer.byteLength(prefix+fragment)
          ||loc.charStart!==base.charStart+slice.charStart
          ||loc.charEnd!==base.charStart+slice.charEnd) invalid();
      }else{
        const base=block.locator;
        // Native item provenance does not change when a chunk is subdivided.
        const stable=(x:IngestLocator)=>({
          item:x.nativeItemRef,representation:x.nativeRepresentation,layer:x.contentLayer,
          locations:x.locations,table:x.table,row:x.row,
          kind:x.locatorKind,rowRange:x.rowRange??null,colRange:x.colRange??null,
          cellBBox:x.cellBBox??null,cellCoordinateOrigin:x.cellCoordinateOrigin??null,
        });
        if(canonical(stable(loc))!==canonical(stable(base))) invalid();
        const length=Array.from(block.originalText).length;
        if((slice.charStart>0||slice.charEnd<length)
          && !loc.diagnostics.includes('native-subspan-unverified')) invalid();
      }
    }
  }
}
