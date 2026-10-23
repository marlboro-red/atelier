import type { Content } from "../../src/shared/schema";
export const templates: {
  name: string;
  description: string;
  content: Content;
}[] = [
  {
    name: "Interactive dashboard",
    description: "Charts, metrics, and a working period filter",
    content: {
      kind: "react",
      entry: "App.tsx",
      files: {
        "App.tsx": `import React, {useState} from 'react';
import {AreaChart,Area,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer} from 'recharts';
const monthly=[{name:'May',value:32},{name:'Jun',value:48},{name:'Jul',value:41},{name:'Aug',value:65},{name:'Sep',value:59},{name:'Oct',value:86}];
export default function App(){const [period,setPeriod]=useState(window.atelier?.getState()?.period||'6 months');window.atelier?.setState({period});const data=period==='3 months'?monthly.slice(3):monthly;return <main style={{fontFamily:'system-ui',padding:'40px',background:'#fbfaf7',minHeight:'100vh',color:'#273c39'}}><div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div><div style={{fontSize:11,letterSpacing:2,color:'#7c8982'}}>STUDIO ANALYTICS / 2026</div><h1 style={{fontFamily:'Georgia',fontWeight:400,fontSize:36,margin:'14px 0 8px'}}>A little perspective.</h1><p style={{color:'#7c8982'}}>Your work, moving in the right direction.</p></div><select aria-label="Period" value={period} onChange={e=>setPeriod(e.target.value)} style={{padding:10,border:'1px solid #ddd',borderRadius:6,background:'white'}}><option>6 months</option><option>3 months</option></select></div><div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:20,margin:'32px 0'}}>{[['Revenue','$86,400','↑ 24% this period'],['Active projects','18','Across 6 teams'],['Satisfaction','98.2%','↑ 3.1% this period']].map(([label,value,note])=><section key={label} style={{padding:24,border:'1px solid #e4e6df',background:'white',borderRadius:10}}><div style={{fontSize:13,color:'#7c8982'}}>{label}</div><div style={{fontSize:32,margin:'12px 0'}}>{value}</div><small style={{color:'#668671'}}>{note}</small></section>)}</div><section style={{padding:24,background:'white',border:'1px solid #e4e6df',borderRadius:10}}><h3 style={{marginTop:0,fontWeight:500}}>Growth over time</h3><p style={{fontSize:13,color:'#7c8982'}}>Revenue · thousands of dollars</p><ResponsiveContainer width="100%" height={280}><AreaChart data={data}><defs><linearGradient id="fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#709b87" stopOpacity={0.3}/><stop offset="100%" stopColor="#709b87" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#eef0eb"/><XAxis dataKey="name" axisLine={false} tickLine={false}/><YAxis axisLine={false} tickLine={false}/><Tooltip/><Area type="monotone" dataKey="value" stroke="#547d69" strokeWidth={3} fill="url(#fill)" isAnimationActive={false}/></AreaChart></ResponsiveContainer></section><footer style={{marginTop:24,fontSize:12,color:'#8c938b'}}>Illustrative data · Made in atelier</footer></main>}`,
      },
    },
  },
  {
    name: "Written document",
    description: "Typography, tables, and mathematical notation",
    content: {
      kind: "markdown",
      entry: "document.md",
      files: {
        "document.md": `# A space for ideas to take shape

Every good project starts with a question. atelier gives that question somewhere to grow: a document, a diagram, a dashboard, or something entirely new.

## Working together

Your agent brings the ideas to life. You bring the perspective. Highlight a sentence, leave a thought, and keep refining until it feels right.

> The best tools leave room for the person using them.

## A simple rhythm

| Step | What happens |
| --- | --- |
| Create | Give an idea its first form |
| Review | Interact, inspect, and leave feedback |
| Refine | Keep what works and improve the rest |
| Share | Export a version worth passing on |

## Room for precision

Mathematical notation belongs alongside the narrative:

$$E = mc^2$$

Every revision stays in your history. Every artifact keeps its identity.
`,
      },
    },
  },
  {
    name: "Flow diagram",
    description: "A Mermaid diagram rendered inside React",
    content: {
      kind: "react",
      entry: "App.tsx",
      files: {
        "App.tsx": `import React,{useEffect,useRef} from 'react';import mermaid from 'mermaid';
export default function App(){const ref=useRef(null);useEffect(()=>{mermaid.initialize({startOnLoad:false,theme:'neutral',securityLevel:'strict'});mermaid.render('workflow','graph LR; A[An idea] --> B[Create]; B --> C[Review]; C --> D[Refine]; D --> C; C --> E[Share];').then(({svg})=>{if(ref.current)ref.current.innerHTML=svg})},[]);return <main style={{padding:48,fontFamily:'system-ui',background:'#faf9f5',minHeight:'100vh'}}><small style={{letterSpacing:2,color:'#8c7c67'}}>THE CREATIVE PROCESS</small><h1 style={{fontFamily:'Georgia',fontSize:36,fontWeight:400}}>From a thought to a thing.</h1><p style={{color:'#777'}}>An ongoing conversation between making and refining.</p><div ref={ref} style={{marginTop:70}}/></main>}`,
      },
    },
  },
  {
    name: "Interactive canvas",
    description: "A browser animation with adjustable motion",
    content: {
      kind: "react",
      entry: "App.tsx",
      files: {
        "App.tsx": `import React,{useEffect,useRef,useState} from 'react';export default function App(){const canvas=useRef(null);const [speed,setSpeed]=useState(1);useEffect(()=>{const el=canvas.current,ctx=el.getContext('2d');let id;function draw(t){ctx.fillStyle='#172d30';ctx.fillRect(0,0,900,480);for(let i=0;i<70;i++){const x=i*14,y=240+Math.sin(i*.14+t*.001*speed)*100;ctx.beginPath();ctx.arc(x,y,3+Math.sin(i*.1)*2,0,Math.PI*2);ctx.fillStyle='#c7dbb6';ctx.fill()}id=requestAnimationFrame(draw)}id=requestAnimationFrame(draw);return()=>cancelAnimationFrame(id)},[speed]);return <main style={{background:'#172d30',color:'#ecf0e6',padding:40,minHeight:'100vh',fontFamily:'system-ui'}}><h1 style={{fontFamily:'Georgia',fontWeight:400,fontSize:36}}>A study in motion.</h1><p>Adjust the rhythm. Watch the pattern change.</p><canvas ref={canvas} width={900} height={480} style={{width:'100%'}}/><label>Speed <input aria-label="Speed" type="range" min="0" max="3" step=".1" value={speed} onChange={e=>setSpeed(Number(e.target.value))}/></label></main>}`,
      },
    },
  },
  {
    name: "Presentation",
    description: "A small deck with slide navigation",
    content: {
      kind: "react",
      entry: "App.tsx",
      files: {
        "App.tsx": `import React,{useState} from 'react';const slides=[['Make room for ideas.','A small introduction to atelier.'],['Create. Review. Refine.','One artifact. An ongoing conversation.'],['Something worth sharing.','Take your work with you as HTML or PDF.']];export default function App(){const [index,setIndex]=useState(window.atelier?.getState()?.index||0);window.atelier?.setState({index});return <main style={{minHeight:'100vh',padding:64,background:index%2?'#243e3a':'#f2e9d8',color:index%2?'#f2e9d8':'#243e3a',display:'flex',flexDirection:'column',justifyContent:'space-between',fontFamily:'system-ui'}}><span style={{fontSize:12,letterSpacing:3}}>ATELIER / A SHORT INTRODUCTION</span><section><h1 style={{fontFamily:'Georgia',fontWeight:400,fontSize:64,maxWidth:700}}>{slides[index][0]}</h1><p style={{fontSize:20}}>{slides[index][1]}</p></section><nav style={{display:'flex',alignItems:'center',gap:20}}><button disabled={!index} onClick={()=>setIndex(index-1)}>Previous</button><span>{index+1} / {slides.length}</span><button disabled={index===slides.length-1} onClick={()=>setIndex(index+1)}>Next</button></nav></main>}`,
      },
    },
  },
];
