import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Artifact,Revision,Comment,Content,Anchor} from '../shared/schema.js';
export class HttpError extends Error {constructor(public statusCode:number,message:string){super(message)}}
export class Store {
 db:DatabaseSync;
 constructor(dir:string){mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(join(dir,'atelier.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions (artifact_id TEXT NOT NULL REFERENCES artifacts(id), number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(artifact_id,number));
 CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS app_data (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), data TEXT NOT NULL);`)}
 list():Artifact[]{return this.db.prepare('SELECT data FROM artifacts').all().map(r=>JSON.parse(r.data as string)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))}
 get(id:string):Artifact {const r=this.db.prepare('SELECT data FROM artifacts WHERE id=?').get(id);if(!r)throw new HttpError(404,'Artifact not found');return JSON.parse(r.data as string)}
 revisions(id:string):Revision[]{this.get(id);return this.db.prepare('SELECT data FROM revisions WHERE artifact_id=? ORDER BY number DESC').all(id).map(r=>JSON.parse(r.data as string))}
 revision(id:string,n?:number):Revision {const a=this.get(id);const r=this.db.prepare('SELECT data FROM revisions WHERE artifact_id=? AND number=?').get(id,n??a.head);if(!r)throw new HttpError(404,'Revision not found');return JSON.parse(r.data as string)}
 transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}}
 create(input:{title:string;description:string;author:string;summary:string;content:Content}):Artifact{return this.transaction(()=>{const now=new Date().toISOString();const a:Artifact={id:randomUUID(),title:input.title,description:input.description,kind:input.content.kind,head:1,createdAt:now,updatedAt:now};this.db.prepare('INSERT INTO artifacts VALUES (?,?)').run(a.id,JSON.stringify(a));this.insertRevision({artifactId:a.id,number:1,author:input.author,summary:input.summary,content:input.content,createdAt:now,commentIds:[]});return a})}
 private insertRevision(r:Revision){this.db.prepare('INSERT INTO revisions VALUES (?,?,?)').run(r.artifactId,r.number,JSON.stringify(r))}
 update(id:string,input:{baseRevision:number;author:string;summary:string;content:Content;commentIds:string[]}):Revision{return this.transaction(()=>{const a=this.get(id);if(a.head!==input.baseRevision)throw new HttpError(409,`Revision conflict: latest is ${a.head}; you started from ${input.baseRevision}`);for(const cid of input.commentIds){const c=this.comment(id,cid);if(c.status!=='resolved'){c.status='addressed';this.saveComment(c)}}const now=new Date().toISOString();const r:Revision={artifactId:id,number:a.head+1,createdAt:now,author:input.author,summary:input.summary,content:input.content,commentIds:input.commentIds};this.insertRevision(r);a.head=r.number;a.kind=r.content.kind;a.updatedAt=now;this.db.prepare('UPDATE artifacts SET data=? WHERE id=?').run(JSON.stringify(a),id);return r})}
 comments(id:string):Comment[]{this.get(id);return this.db.prepare('SELECT data FROM comments WHERE artifact_id=?').all(id).map(r=>JSON.parse(r.data as string))}
 comment(id:string,cid:string):Comment{const c=this.comments(id).find(c=>c.id===cid);if(!c)throw new HttpError(404,'Comment not found');return c}
 addComment(id:string,input:{revision:number;body:string;author:string;anchor:Anchor|null}):Comment{this.revision(id,input.revision);const c:Comment={...input,id:randomUUID(),artifactId:id,status:'open',createdAt:new Date().toISOString(),replies:[]};this.saveComment(c);return c}
 saveComment(c:Comment){this.db.prepare('INSERT INTO comments VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(c.id,c.artifactId,JSON.stringify(c))}
 data(id:string):unknown{this.get(id);const row=this.db.prepare('SELECT data FROM app_data WHERE artifact_id=?').get(id);return row?JSON.parse(row.data as string):null}
 setData(id:string,data:unknown){this.get(id);this.db.prepare('INSERT INTO app_data VALUES (?,?) ON CONFLICT(artifact_id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(data))}
 close(){this.db.close()}
}
