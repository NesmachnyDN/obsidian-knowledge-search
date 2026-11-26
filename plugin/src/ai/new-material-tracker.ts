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
  /** A modify/metadata event is not creation evidence. Preserve only exact live identity. */
  changed(path:string,owner:T):void {
    if(this.overflow||!validPath(path))return;
    if(this.entries.has(path)&&this.entries.get(path)!==owner)this.entries.set(path,null);
  }
  /** Only an exact file-owner move can carry creation provenance to a new path. */
  renamed(oldPath:string,path:string,owner:T):void {
    if(this.overflow)return;
    if(oldPath===path){this.changed(path,owner);return;}
    const known=validPath(oldPath)&&this.entries.get(oldPath)===owner;
    const collision=this.entries.has(path);
    this.invalidate(oldPath);
    if(!validPath(path))return;
    if(collision){this.entries.set(path,null);return;}
    if(known)this.entries.set(path,owner);
  }
  invalidate(path:string):void {
    for(const key of this.entries.keys())if(key===path||key.startsWith(path+'/'))this.entries.delete(key);
  }
  state(path:string,owner:T):'verified-new'|'unresolved' {
    return !this.overflow&&this.entries.get(path)===owner?'verified-new':'unresolved';
  }
  clear():void {this.entries.clear();this.overflow=false;}
}
