import { BOUNDS, validPath } from '../standalone/contracts';

/** Ephemeral native-event provenance. Unknown/reload is never verified-new. */
export class NewMaterialTracker<T extends object> {
  private readonly entries=new Map<string,T|null>();
  private overflow=false;
  created(path:string,owner:T):void {
    if(this.overflow||!validPath(path))return;
    if(this.entries.size>=BOUNDS.sources&&!this.entries.has(path)){this.entries.clear();this.overflow=true;return;}
    // Duplicate create for an existing tracked path is ambiguous.
    if(this.entries.has(path)){this.entries.set(path,null);return;}
    this.entries.set(path,owner);
  }
  invalidate(path:string):void {
    for(const key of this.entries.keys())if(key===path||key.startsWith(path+'/'))this.entries.delete(key);
  }
  state(path:string,owner:T):'verified-new'|'unresolved' {
    return !this.overflow&&this.entries.get(path)===owner?'verified-new':'unresolved';
  }
  clear():void {this.entries.clear();this.overflow=false;}
}
