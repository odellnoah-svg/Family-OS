import { useState, useMemo, useEffect, useRef, useCallback } from "react";

const fmt = n => n == null ? "—" : (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString("en-US");
const kfmt = n => n == null ? "—" : (n < 0 ? "-$" : "$") + (Math.abs(n) >= 10000 ? Math.round(Math.abs(n)/1000) + "K" : Math.round(Math.abs(n)).toLocaleString("en-US"));
const pfmt = n => (n * 100).toFixed(1) + "%";
const T = "#3D2B1A";
const WS = {padding:20};

// ── Scenario / Drive constants ────────────────────────────────────────────────
const CLIENT_ID = "521715334457-q7nj2n1s1puocusm8d69rdh09mf4u19f.apps.googleusercontent.com";
const FOLDER_ID = "1r-PPHMSRWSRauQSlB9Mz4hgs_tEcaQSY";
const RPP_TAG   = "rpp-planner-v1";
const SCOPES    = "https://www.googleapis.com/auth/drive.file";

const driveAPI = {
  async list(token) {
    const q = encodeURIComponent("'" + FOLDER_ID + "' in parents and name contains '" + RPP_TAG + "' and trashed=false");
    const r = await fetch("https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=files(id,name,description,modifiedTime)&orderBy=modifiedTime%20desc",
      { headers:{ Authorization:"Bearer " + token } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error ? d.error.message : "list failed");
    return (d.files||[]).map(function(f) {
      var m = {}; try { m = JSON.parse(f.description||"{}"); } catch(e) {}
      return Object.assign({}, f, {meta:m});
    });
  },
  async load(token, fileId) {
    const r = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media",
      { headers:{ Authorization:"Bearer " + token } });
    if (!r.ok) throw new Error("load failed");
    return r.json();
  },
  async save(token, name, type, year, data, existingId) {
    const meta = { name:name, type:type, year:year, savedAt:new Date().toISOString() };
    const slug = name.replace(/[^a-zA-Z0-9]/g,"-").toLowerCase();
    const fileName = RPP_TAG + "-" + year + "-" + slug + ".json";
    const fileMeta = existingId
      ? { name:fileName, description:JSON.stringify(meta) }
      : { name:fileName, description:JSON.stringify(meta), parents:[FOLDER_ID] };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(fileMeta)], {type:"application/json"}));
    form.append("file",     new Blob([JSON.stringify({meta:meta,data:data})], {type:"application/json"}));
    const url = existingId
      ? "https://www.googleapis.com/upload/drive/v3/files/" + existingId + "?uploadType=multipart"
      : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
    const r = await fetch(url, { method: existingId ? "PATCH" : "POST",
      headers:{ Authorization:"Bearer " + token }, body:form });
    if (!r.ok) throw new Error("save failed");
    return r.json();
  },
  async remove(token, fileId) {
    const r = await fetch("https://www.googleapis.com/drive/v3/files/" + fileId,
      { method:"DELETE", headers:{ Authorization:"Bearer " + token } });
    if (!r.ok) throw new Error("delete failed");
  },
};

const TIPS = {
  "BIV": "Beginning Inventory Value — the dollar value of all your livestock at the start of the year. Feeds into the Gross Product formula.",
  "CIV": "Closing Inventory Value — the dollar value of livestock at year end. A higher CIV than BIV means the herd grew in value.",
  "Gross Product": "CIV + Livestock Sales - BIV. Total economic output of the enterprise — what was produced, not just what was sold. The RFP equivalent of revenue.",
  "Combined Gross Product": "Sum of Gross Product across all enterprises (Cattle + Sheep + Goats).",
  "Gross Margin": "Gross Product minus Direct Costs. What the enterprise contributes before overhead is deducted. Target: as high as possible.",
  "Combined Gross Margin": "Sum of Gross Margin across all enterprises. Used to cover shared overhead.",
  "Gross Margin Ratio": "Gross Margin Ratio = GM / GP. Target >= 70%. Shows what percentage of output survives direct costs. Below 70% means direct costs are eating too much of the enterprise.",
  "GMR (Combined)": "Gross Margin Ratio across all enterprises combined. Target >= 70%.",
  "Direct Costs": "Costs that vary directly with the enterprise: feed, vet, freight, and opportunity cost on inventory. If you shut down this enterprise, these costs disappear.",
  "Opportunity cost": "A charge of ~10% on Beginning Inventory Value. Treats the capital tied up in livestock as a real cost — what that money could have earned elsewhere.",
  "Operating P(L)": "All Enterprises Gross Margin minus Total Overheads. The operation's profit or loss before other income.",
  "Business P(L)": "Operating P(L) plus other income such as hunting leases or land leases. The full business bottom line.",
  "Enterprise P(L)": "This enterprise's Gross Margin minus its SAU-allocated share of shared overhead. Shows whether this enterprise is pulling its weight.",
  "Overhead Ratio": "Total Overheads / Gross Product. Target <= 40%. Measures the overhead burden. Above 100% means overheads exceed all enterprise output.",
  "Cash Overheads": "Total overheads minus non-cash items (opportunity rent, improvement budget, depreciation). Closer to the actual cash leaving the operation.",
  "Total Overheads": "All overhead costs — land, labor, and machinery. These exist regardless of how each enterprise performs.",
  "Working Capital Days": "Working Capital / Cash Overheads x 365. Target > 150 days. How many days the operation can cover its cash overheads from current liquid assets.",
  "ROA": "Return on Assets = Operating P(L) / Total Operating Assets. Target >= 10%. Are the assets working hard enough?",
  "Asset Turnover": "Asset Turnover Ratio = GP / Total Operating Assets. Target >= 25%. How much gross output each dollar of assets generates.",
  "SAU": "Standard Animal Unit. A common measure to compare different livestock classes. Mature cow = 1.0 SAU. Used to allocate shared overheads fairly.",
  "Cattle SAU": "Total Standard Animal Units for cattle. Cows = 1.0, H1 heifers = 0.7, H2 heifers = 0.8, bulls = 1.5.",
  "Hunting / lease / other": "Non-livestock income that flows through the trading account — hunting leases, hay sales, custom grazing, or any other ranch income. It adds to Total Revenue and Business P(L) but is not included in Gross Product (which is livestock-only).",
  "Livestock sales": "Cash received from selling livestock — calves, cull cows, open cows, etc. Does not include non-livestock income.",
  "GP per FTE": "Gross Product per Full-Time Employee. Target > $400K. A measure of labor productivity across the whole operation.",
  "Wet cows (weaned a calf)": "Cows that successfully nursed and weaned a calf this cycle. The productive core of the breeding herd.",
  "Preg cows at close": "Cows confirmed pregnant at year end. These become next year's opening breeding inventory.",
  "Open": "Females exposed to a male but failed to conceive — not pregnant at pregnancy check.",
  "Dry": "Live females that failed to wean any offspring despite being in the herd during the breeding season.",
  "Culls": "Females removed from the breeding herd for performance or structural reasons.",
  "Change in net worth": "Closing Net Worth minus Opening Net Worth. The truest measure of whether the year grew or shrank family wealth — more honest than cash flow alone.",
  "Net Worth": "Total Assets minus Total Liabilities. What the family actually owns free and clear.",
  "Working capital": "Current Assets minus Current Liabilities. The liquid cushion available to run day-to-day operations.",
  "Bred and kept at close": "Females confirmed bred/pregnant at year end — next year's opening breeding stock.",
  "Profit / Acre": "Business P(L) divided by total grazed acres (or owned acres if grazed not set). A land productivity metric — how much profit the operation generates per acre of country. Negative means overheads are consuming all enterprise output.",
  "Cash Contribution": "Total Revenue minus all actual cash costs (cash direct costs + cash overheads, excluding opportunity cost, depreciation, and unpaid labour). Shows how much real cash the operation generated. Displayed in the top bar as Cash Contrib.",
};

function TipIcon({text}) {
  const [show, setShow] = useState(false);
  return (
    <span style={{position:"relative",display:"inline-block",marginLeft:4,verticalAlign:"middle"}}>
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        style={{fontSize:9,color:"#94a3b8",cursor:"help",border:"1px solid #cbd5e1",borderRadius:"50%",width:14,height:14,display:"inline-flex",alignItems:"center",justifyContent:"center",lineHeight:1,flexShrink:0,userSelect:"none"}}>
        ?
      </span>
      {show && (
        <div style={{position:"absolute",left:18,top:-8,zIndex:999,background:"#2D1B0E",color:"white",fontSize:11,padding:"9px 11px",borderRadius:7,width:260,boxShadow:"0 4px 20px rgba(0,0,0,0.45)",lineHeight:1.6,fontWeight:400,pointerEvents:"none"}}>
          {text}
          <div style={{position:"absolute",left:-5,top:12,width:0,height:0,borderTop:"5px solid transparent",borderBottom:"5px solid transparent",borderRight:"5px solid #2D1B0E"}}/>
        </div>
      )}
    </span>
  );
}


// ── State ────────────────────────────────────────────────────────────────────
const BSI = {cash:0,ar:0,hayCrops:0,otherCurrent:0,vehicles:0,machinery:0,equipment:0,land:0,buildings:0,improvements:0,offFarm:0,currentLiab:0,intermediateLiab:0,longTermLiab:0};
const INIT = {
  herd:  {cows:86,h2:0,h1:10,bulls:3,deathPct:1,dryPct:3,cullPct:3,openPct:5,h1Kept:10},
  val:   {cowPreg:1600,bull:4500,h1:0,h2:0},
  sales: {steersSold:25,heifersSold:35,openCow:1500,cullCow:1500,steerWt:350,steerPPLb:3.75,hfWt:350,hfPPLb:3.75,other:3000},
  dc:    {oppPct:10,feed:13500,vet:2000,freight:2000},
  sheep: {
    herd:  {females:115,males:5,deathPct:3,dryPct:5,cullPct:10,openPct:8,litterRate:1.5,replacementsKept:15},
    val:   {femalePerHead:200,malePerHead:400},
    sales: {offspringSold:120,offspringWt:65,offspringPPLb:2.50,cullPerHead:150,other:0},
    dc:    {oppPct:10,feed:3000,vet:800,freight:800},
  },
  goats: {
    herd:  {females:35,males:3,deathPct:3,dryPct:8,cullPct:10,openPct:10,litterRate:1.8,replacementsKept:5},
    val:   {femalePerHead:175,malePerHead:350},
    sales: {offspringSold:40,offspringWt:50,offspringPPLb:1.75,cullPerHead:120,other:0},
    dc:    {oppPct:10,feed:1000,vet:400,freight:400},
  },
  leases: {
    income: { hunting:0, grazing:0, camping:0, other:0 },
    dc:     { maintenance:0, wildlife:0, other:0 },
  },
  oh:    {oppRent:6000,util:1000,upkeep:2000,impr:2000,unpaid:37000,hired:0,depr:10000,fuel:2000,repairs:700,ins:2000,supplies:1000,other:100},
  prop:  {acresOwned:525,acresGrazed:655,ftes:1},
  bsOpen:  {...BSI},
  bsClose: {...BSI},
};

// ── Compute ───────────────────────────────────────────────────────────────────
function computeSR(sr, sauF, sauM, econ=true) {
  const h=sr.herd, v=sr.val, s=sr.sales, d=sr.dc;
  const deaths=Math.ceil(h.females*h.deathPct/100), live=h.females-deaths;
  const dry=Math.ceil(live*h.dryPct/100), wet=live-dry;
  const culls=Math.ceil(wet*h.cullPct/100), exposed=wet-culls;
  const open=Math.ceil(exposed*h.openPct/100), bred=exposed-open;
  const bioOffspring=Math.round(wet*h.litterRate);
  const biv=h.females*v.femalePerHead+h.males*v.malePerHead;
  const civ=bred*v.femalePerHead+h.males*v.malePerHead;
  const cullSales=(culls+open+dry)*s.cullPerHead;
  const offspringSales=s.offspringSold*s.offspringWt*s.offspringPPLb;
  const lsSales=cullSales+offspringSales, revenue=lsSales+s.other;
  const gp=civ+lsSales-biv, oppCost=econ?biv*d.oppPct/100:0;
  const totalDC=oppCost+d.feed+d.vet+d.freight, gm=gp-totalDC;
  const sau=h.females*sauF+h.males*sauM;
  return {deaths,dry,wet,culls,open,bred,bioOffspring,biv,civ,cullSales,offspringSales,lsSales,revenue,gp,oppCost,totalDC,gm,sau,gmr:gp?gm/gp:0};
}
function computeLeases(l) {
  const gp = l.income.hunting + l.income.grazing + l.income.camping + l.income.other;
  const totalDC = l.dc.maintenance + l.dc.wildlife + l.dc.other;
  const gm = gp - totalDC;
  return { gp, totalDC, gm, gmr: gp ? gm/gp : 0, revenue: gp, cashDC: totalDC };
}
function bsCalc(b, ls) {
  const ca=b.cash+b.ar+b.hayCrops+b.otherCurrent;
  const ve=b.vehicles+b.machinery+b.equipment, inter=ls+ve;
  const lt=b.land+b.buildings+b.improvements, ops=ca+inter+lt;
  const total=ops+b.offFarm, liab=b.currentLiab+b.intermediateLiab+b.longTermLiab;
  return {ca,ve,inter,lt,ops,total,liab,nw:total-liab};
}
function compute(data, profitView="economic") {
  const econ = profitView === "economic";
  const {herd:h,val:v,sales:s,dc,sheep,goats,leases,oh,prop,bsOpen,bsClose}=data;
  const deaths=Math.ceil(h.cows*h.deathPct/100), live=h.cows-deaths;
  const dry=Math.ceil(live*h.dryPct/100), wet=live-dry;
  const culls=Math.ceil(wet*h.cullPct/100), exposed=wet-culls;
  const open=Math.ceil(exposed*h.openPct/100), pregKept=exposed-open;
  const bioSteers=Math.round(wet/2), bioHfSold=Math.max(0,wet-bioSteers-h.h1Kept);
  const biv=h.cows*v.cowPreg+h.bulls*v.bull+h.h1*v.h1+h.h2*v.h2;
  const civ=pregKept*v.cowPreg+h.bulls*v.bull;
  const cowSales=(open+dry)*s.openCow+culls*s.cullCow;
  const calfSales=s.steersSold*s.steerWt*s.steerPPLb+s.heifersSold*s.hfWt*s.hfPPLb;
  const lsSales=cowSales+calfSales, revenue=lsSales;
  const gp=civ+lsSales-biv, oppCost=econ?biv*dc.oppPct/100:0;
  const totalDC=oppCost+dc.feed+dc.vet+dc.freight, gm=gp-totalDC;
  const cattleSAU=h.cows+h.h1*0.7+h.h2*0.8+h.bulls*1.5;
  const sr_s=computeSR(sheep,0.20,0.25,econ), sr_g=computeSR(goats,0.17,0.20,econ), lr=computeLeases(leases);
  const landOH=(econ?oh.oppRent:0)+oh.util+oh.upkeep+oh.impr;
  const laborOH=(econ?oh.unpaid:0)+oh.hired;
  const thingsOH=oh.depr+oh.fuel+oh.repairs+oh.ins+oh.supplies;
  const totalOH=landOH+laborOH+thingsOH+oh.other;
  const cashOH=totalOH-(econ?oh.oppRent:0)-oh.impr-oh.depr;
  const trueCashOH=cashOH-(econ?oh.unpaid:0);
  const totalSAU=cattleSAU+sr_s.sau+sr_g.sau;
  const cShare=totalSAU?cattleSAU/totalSAU:1, sShare=totalSAU?sr_s.sau/totalSAU:0, gShare=totalSAU?sr_g.sau/totalSAU:0;
  const cOH=totalOH*cShare, sOH=totalOH*sShare, gOH=totalOH*gShare;
  const allGP=gp+sr_s.gp+sr_g.gp+lr.gp, allGM=gm+sr_s.gm+sr_g.gm+lr.gm;
  const allRev=revenue+sr_s.revenue+sr_g.revenue+lr.revenue;
  const opPL=allGM-totalOH, bizPL=opPL;
  const cashNI=allRev-(dc.feed+dc.vet+dc.freight)-(sheep.dc.feed+sheep.dc.vet+sheep.dc.freight)-(goats.dc.feed+goats.dc.vet+goats.dc.freight)-lr.cashDC-trueCashOH;
  const allBIV=biv+sr_s.biv+sr_g.biv, allCIV=civ+sr_s.civ+sr_g.civ;
  const bso=bsCalc(bsOpen,allBIV), bsc=bsCalc(bsClose,allCIV);
  const wc=bso.ca-bsOpen.currentLiab, wcd=cashOH>0?(wc/cashOH)*365:null;
  const roa=bso.ops>0?opPL/bso.ops:null, atr=bso.ops>0?allGP/bso.ops:null;
  const acres=prop.acresGrazed||prop.acresOwned;
  return {
    deaths,dry,wet,culls,open,pregKept,bioSteers,bioHfSold,
    biv,civ,cowSales,calfSales,lsSales,revenue,gp,oppCost,totalDC,gm,cattleSAU,
    leases:lr,
    sheep:sr_s,sheepOH:sOH,sheepShare:sShare,sheepPL:sr_s.gm-sOH,
    goats:sr_g,goatOH:gOH,goatShare:gShare,goatPL:sr_g.gm-gOH,
    cattleOH:cOH,cattleShare:cShare,cattlePL:gm-cOH,
    landOH,laborOH,thingsOH,totalOH,cashOH,trueCashOH,totalSAU,
    allGP,allGM,allRev,opPL,bizPL,cashNI,profitView,
    gmr:allGP?allGM/allGP:0, orate:allGP?totalOH/allGP:0, gpFte:allGP/(prop.ftes||1),
    allBIV,allCIV,bso,bsc,wc,wcd,roa,atr,nwChange:bsc.nw-bso.nw,
    gpAcre:acres?allGP/acres:null,gmAcre:acres?allGM/acres:null,
  };
}

// ── Primitive UI ──────────────────────────────────────────────────────────────
function Inp({val, onChange, pre, suf}) {
  const [raw, setRaw] = useState(null);
  const fmtD = val != null ? Number(val).toLocaleString("en-US") : "0";
  const displayVal = raw !== null ? raw : fmtD;
  const handleFocus = () => setRaw(String(val != null ? val : 0));
  const handleBlur  = () => setRaw(null);
  const handleChange = (e) => {
    setRaw(e.target.value);
    const n = Number(e.target.value.replace(/,/g, ""));
    if (!isNaN(n)) onChange(n);
  };
  return (
    <div style={{display:"flex",alignItems:"center",gap:4}}>
      {pre && <span style={{fontSize:12,color:"#4A7CC5",fontWeight:600}}>{pre}</span>}
      <input type="text" inputMode="decimal" value={displayVal}
        onFocus={e => { handleFocus(); e.target.style.outline="2px solid #3B82F6"; e.target.style.outlineOffset="1px"; }}
        onBlur={e => { handleBlur(); e.target.style.outline="none"; }}
        onChange={handleChange}
        style={{width:74,border:"1px solid #93C5FD",borderRadius:5,padding:"3px 7px",textAlign:"right",fontSize:13,fontWeight:600,background:"#EBF5FF",color:"#1A3A6B",outline:"none",boxSizing:"border-box"}}/>
      {suf && <span style={{fontSize:12,color:"#4A7CC5",fontWeight:600,marginLeft:2}}>{suf}</span>}
    </div>
  );
}
function Field({label, val, set, pre, suf, step, min}) {
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #F0EBE3"}}>
      <div style={{fontSize:13,color:"#5A4A38"}}>{label}</div>
      <Inp val={val} onChange={set} pre={pre} suf={suf}/>
    </div>
  );
}
// Dual-input: count and % linked — editing either updates the other via recompute
function RateField({label, pctVal, setPct, count, base}) {
  const handleCountChange = (n) => { if (base > 0) setPct((n / base) * 100); };
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 68px 68px",gap:6,alignItems:"center",padding:"8px 0",borderBottom:"1px solid #F0EBE3"}}>
      <div style={{fontSize:13,color:"#5A4A38"}}>{label}</div>
      <Inp val={count} onChange={handleCountChange}/>
      <Inp val={pctVal} onChange={setPct} suf="%"/>
    </div>
  );
}
function Grp({label}) {
  return (
    <div style={{fontSize:10,fontWeight:700,color:"#4A2C0A",textTransform:"uppercase",letterSpacing:"0.12em",margin:"22px 0 10px",padding:"6px 10px",background:"#F0E4C8",borderRadius:5,borderLeft:"3px solid #8B6437"}}>
      {label}
    </div>
  );
}
function Row({label, value, bold, indent, hi}) {
  const tip = TIPS[label];
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",paddingLeft:indent?14:3,borderBottom:"1px solid #F0EBE3",background:hi?"#FDF5E0":"transparent",borderLeft:hi?"3px solid #C4993B":"3px solid transparent"}}>
      <span style={{fontSize:13,color:bold?"#1A1208":"#5A4A38",fontWeight:bold?600:400,display:"flex",alignItems:"center",gap:4}}>
        {label}{tip && <TipIcon text={tip}/>}
      </span>
      <span style={{fontSize:13,fontWeight:bold?600:400,color:"#1A1208",fontVariantNumeric:"tabular-nums"}}>{value}</span>
    </div>
  );
}
function Hint({children}) {
  return <div style={{fontSize:11,color:"#9B8B7A",padding:"2px 0 6px",lineHeight:1.4}}>{children}</div>;
}
// White card section with styled header
function Section({icon, label, children}) {
  return (
    <div style={{background:"white",borderRadius:8,border:"1px solid #E5DDD0",boxShadow:"0 1px 3px rgba(0,0,0,0.04)",marginBottom:14,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"11px 16px",borderBottom:"1px solid #EDE8E0"}}>
        <div style={{width:3,height:14,background:"#6B4C2A",borderRadius:2,flexShrink:0}}/>
        <span style={{fontSize:11,fontWeight:700,color:"#1A1208",textTransform:"uppercase",letterSpacing:"0.1em"}}>{label}</span>
      </div>
      <div style={{padding:"0 16px 12px"}}>{children}</div>
    </div>
  );
}
// Enterprise page header: breadcrumb + icon + title + KPI strip
function EntHdr({nm, subtitle, AnimalIcon, kpis, onNav, largeIcon}) {
  return (
    <div style={{marginBottom:24}}>
      <div style={{fontSize:12,color:"#9B8B7A",marginBottom:16,display:"flex",gap:6,alignItems:"center"}}>
        <span style={{cursor:"pointer",color:"#5A3E28"}} onClick={() => onNav("home")}>Enterprises</span>
        <span style={{color:"#C4A882"}}>›</span>
        <span style={{color:"#1A1208",fontWeight:500}}>{nm}</span>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:22}}>
        <div style={{width:largeIcon?72:52,height:largeIcon?72:52,borderRadius:10,background:"#1E3A10",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
          <div style={{width:largeIcon?60:36,height:largeIcon?60:36,display:"flex",alignItems:"center",justifyContent:"center",filter:"brightness(0) invert(1)"}}><AnimalIcon/></div>
        </div>
        <div>
          <div style={{fontSize:22,fontWeight:700,color:"#1A1208",letterSpacing:"-0.02em"}}>{nm} Enterprise</div>
          <div style={{fontSize:13,color:"#9B8B7A",marginTop:2}}>{subtitle}</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:4}}>
        {kpis.map(({label,value,neg}) => (
          <div key={label} style={{background:"white",borderRadius:8,padding:"12px 14px",border:"1px solid #E5DDD0",borderTop:`3px solid ${neg?"#DC2626":"#2A5F1A"}`,boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
            <div style={{fontSize:10,color:"#9B8B7A",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:5,fontWeight:600}}>{label}</div>
            <div style={{fontSize:17,fontWeight:700,color:neg?"#DC2626":"#1A1208",fontVariantNumeric:"tabular-nums"}}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BC({label, display, color}) {
  const tip = TIPS[label];
  return (
    <div style={{padding:"12px 14px",borderRadius:8,background:"white",border:"1px solid #E5DDD0",borderTop:`3px solid ${color||"#6B4C2A"}`,boxShadow:"0 1px 3px rgba(0,0,0,0.04)",marginBottom:0}}>
      <div style={{fontSize:10,color:"#9B8B7A",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:5,fontWeight:600,display:"flex",alignItems:"center",gap:3}}>
        {label}{tip && <TipIcon text={tip}/>}
      </div>
      <div style={{fontSize:20,fontWeight:700,color:color||"#1A1208",fontVariantNumeric:"tabular-nums"}}>{display}</div>
    </div>
  );
}

// ── Animal Icons ─────────────────────────────────────────────────────────────
const SHEEP_IMG = "data:image/png;base64,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";
const COW_IMG   = "data:image/png;base64,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";
const GOAT_IMG  = "data:image/png;base64,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";

function CowIcon() {
  return <img src={COW_IMG} alt="Cattle" style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain",display:"block"}}/>;
}
function SheepIcon() {
  return <img src={SHEEP_IMG} alt="Sheep" style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain",display:"block"}}/>;
}
function GoatIcon() {
  return <img src={GOAT_IMG} alt="Goats" style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain",display:"block"}}/>;
}

const HUNTING_IMG = "data:image/png;base64,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";
function DeerIcon() {
  return <img src={HUNTING_IMG} alt="Leases & Hunting" style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain",display:"block"}}/>;
}

// ── Enterprise Card ───────────────────────────────────────────────────────────
function EntCard({name, nav, onNav, gp, gm, gmr, oh, pl, sau, color, bg, border, Icon}) {
  const plC = pl >= 0 ? "#15803d" : "#b91c1c";
  const MR = (lbl, val, hilite) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
      <span style={{fontSize:11,color:"rgba(0,0,0,0.42)"}}>{lbl}</span>
      <span style={{fontSize:12,fontWeight:hilite?600:400,color:hilite?plC:color,fontVariantNumeric:"tabular-nums"}}>{val}</span>
    </div>
  );
  return (
    <button type="button" onClick={() => onNav(nav)} style={{
      background:"white", borderLeft:`4px solid ${border}`, borderTop:"none",
      borderRight:"none", borderBottom:"none", borderRadius:10,
      padding:"16px 14px 14px", cursor:"pointer", textAlign:"left",
      width:"100%", height:"100%", display:"flex", flexDirection:"column",
      boxShadow:"0 2px 8px rgba(0,0,0,0.07)"}}>
      <div style={{height:72,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
        <Icon/>
      </div>
      <div style={{fontSize:15,fontWeight:700,color,textAlign:"center",
                   marginBottom:10,paddingBottom:8,
                   borderBottom:`1px solid rgba(0,0,0,0.08)`}}>{name}</div>
      <div style={{flex:1}}>
        {MR("Gross Product", fmt(gp))}
        {MR("Gross Margin", fmt(gm))}
        {MR("GMR", pfmt(gmr))}
        {MR("OH Allocation", fmt(oh))}
        {MR("Enterprise P(L)", fmt(pl), true)}
        <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0"}}>
          <span style={{fontSize:11,color:"rgba(0,0,0,0.42)"}}>SAU</span>
          <span style={{fontSize:12,color,fontVariantNumeric:"tabular-nums"}}>{sau.toFixed(1)}</span>
        </div>
      </div>
    </button>
  );
}


// ── Combined Ranch Card ─────────────────────────────────────────────────────
function CombinedCard({r, onNav}) {
  const plC = r.bizPL >= 0 ? "#15803d" : "#b91c1c";
  const MR = (lbl, val, hilite) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid rgba(255,255,255,0.15)"}}>
      <span style={{fontSize:11,color:"rgba(255,255,255,0.65)"}}>{lbl}</span>
      <span style={{fontSize:12,fontWeight:hilite?700:400,color:hilite?( r.bizPL>=0?"#86efac":"#fca5a5"):"white",fontVariantNumeric:"tabular-nums"}}>{val}</span>
    </div>
  );
  const totalSAU = (r.cattleSAU + r.sheep.sau + r.goats.sau).toFixed(1);
  return (
    <button type="button" onClick={() => onNav("results")} style={{
      background:T, border:"none", borderRadius:10,
      padding:"16px 14px 14px", cursor:"pointer", textAlign:"left",
      width:"100%", height:"100%", display:"flex", flexDirection:"column",
      boxShadow:"0 2px 8px rgba(0,0,0,0.15)"}}>
      <div style={{height:72,width:"100%",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:8}}>
        <svg width="52" height="52" viewBox="0 0 52 52">
          <polygon points="26,4 50,20 50,50 2,50 2,20" fill="rgba(255,255,255,0.12)"/>
          <polygon points="0,21 26,3 52,21" fill="rgba(255,255,255,0.2)"/>
          <rect x="20" y="32" width="12" height="18" rx="1" fill="rgba(255,255,255,0.9)"/>
          <rect x="5" y="27" width="10" height="10" rx="1" fill="rgba(255,255,255,0.7)"/>
          <rect x="37" y="27" width="10" height="10" rx="1" fill="rgba(255,255,255,0.7)"/>
          <line x1="26" y1="32" x2="26" y2="50" stroke={T} strokeWidth="1"/>
        </svg>
      </div>
      <div style={{fontSize:15,fontWeight:700,color:"white",textAlign:"center",
                   marginBottom:10,paddingBottom:8,
                   borderBottom:"1px solid rgba(255,255,255,0.2)"}}>Combined Ranch</div>
      <div style={{flex:1}}>
        {MR("All GP", fmt(r.allGP))}
        {MR("All GM", fmt(r.allGM))}
        {MR("GMR", pfmt(r.gmr))}
        {MR("OVHD Ratio", pfmt(r.orate))}
        {MR("Business P(L)", fmt(r.bizPL), true)}
        {MR("Cash Contrib", fmt(r.cashNI))}
        <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0"}}>
          <span style={{fontSize:11,color:"rgba(255,255,255,0.65)"}}>Total SAU</span>
          <span style={{fontSize:12,color:"white",fontVariantNumeric:"tabular-nums"}}>{totalSAU}</span>
        </div>
      </div>
    </button>
  );
}

// ── Home Screen ───────────────────────────────────────────────────────────────
function HomeScreen({r, d, onNav, profitView, setProfitView}) {
  const cs = {cursor:"pointer"};
  const allBIVStr = fmt(r.allBIV), allCIVStr = fmt(r.allCIV);
  const cattleHd = d.herd.cows + " cows . " + r.wet + " weaned";
  const sfStr = r.pregKept + " preg . " + d.sales.steersSold + "s/" + d.sales.heifersSold + "h";
  const gpStr = "C:" + kfmt(r.gp) + "  S:" + kfmt(r.sheep.gp) + "  G:" + kfmt(r.goats.gp);
  const gmStr = "C:" + kfmt(r.gm) + "  S:" + kfmt(r.sheep.gm) + "  G:" + kfmt(r.goats.gm);
  const plStr = "C:" + kfmt(r.cattlePL) + "  S:" + kfmt(r.sheepPL) + "  G:" + kfmt(r.goatPL);
  const valOpenStr = "C:" + kfmt(r.biv) + "  S:" + kfmt(r.sheep.biv) + "  G:" + kfmt(r.goats.biv);
  const valCloseStr = "C:" + kfmt(r.civ) + "  S:" + kfmt(r.sheep.civ) + "  G:" + kfmt(r.goats.civ);
  const dcAll = r.totalDC + r.sheep.totalDC + r.goats.totalDC;
  const acresBase = d.prop.acresGrazed || d.prop.acresOwned;
  const plAcre = acresBase ? r.bizPL / acresBase : null;
  const sheepHd = d.sheep.herd.females + " ewes . " + d.goats.herd.females + " does";
  const combinedGMStr = fmt(r.allGM) + " . " + pfmt(r.gmr);
  const Op = ({sym}) => (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",
                 color:"#C4A882",fontSize:20,fontWeight:700,padding:"0 2px",
                 flexShrink:0,userSelect:"none",alignSelf:"center"}}>{sym}</div>
  );
  return (
    <div>
      {/* ── Profit View toggle ──────────────────────────────────── */}
      <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12,gap:8}}>
        <span style={{fontSize:11,color:"#8B6437",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em"}}>Profit View</span>
        <div style={{display:"flex",borderRadius:20,overflow:"hidden",border:"2px solid #C4993B",background:"#F0E4C8"}}>
          <button type="button" onClick={() => setProfitView("economic")} style={{background:profitView==="economic"?T:"transparent",color:profitView==="economic"?"white":"#3D2B1A",border:"none",padding:"4px 14px",fontSize:11,fontWeight:700,cursor:"pointer",borderRadius:20}}>Economic</button>
          <button type="button" onClick={() => setProfitView("accounting")} style={{background:profitView==="accounting"?T:"transparent",color:profitView==="accounting"?"white":"#3D2B1A",border:"none",padding:"4px 14px",fontSize:11,fontWeight:700,cursor:"pointer",borderRadius:20}}>Accounting</button>
        </div>
      </div>
      {/* ── Summary metrics ─────────────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:10,marginBottom:14}}>
        {[
          {label:"Gross Product",     value:fmt(r.allGP),                                         tip:TIPS["Gross Product"]},
          {label:"Gross Margin",      value:fmt(r.allGM),                                         tip:TIPS["Gross Margin"]},
          {label:"Gross Margin Ratio",value:pfmt(r.gmr),                                          tip:TIPS["Gross Margin Ratio"]},
          {label:"Profit / Acre",     value:plAcre!==null?kfmt(plAcre):"—", neg:plAcre!==null&&plAcre<0, tip:TIPS["Profit / Acre"]},
          {label:"Business P(L)",     value:fmt(r.bizPL), neg:r.bizPL<0,                          tip:TIPS["Business P(L)"]},
          {label:"Cash Contrib",      value:fmt(r.cashNI),                                        tip:TIPS["Cash Contribution"]},
        ].map(({label,value,neg,tip}) => (
          <div key={label} style={{background:"white",borderRadius:8,padding:"12px 16px",
                                   border:"1px solid #E5DDD0",
                                   borderTop:`3px solid ${neg?"#DC2626":"#2A5F1A"}`,
                                   boxShadow:"0 1px 3px rgba(0,0,0,0.04)"}}>
            <div style={{fontSize:10,color:"#9B8B7A",textTransform:"uppercase",
                         letterSpacing:"0.08em",marginBottom:5,fontWeight:600,display:"flex",alignItems:"center"}}>
              {label}{tip && <TipIcon text={tip}/>}
            </div>
            <div style={{fontSize:18,fontWeight:700,
                         color:neg?"#DC2626":"#1A1208",
                         fontVariantNumeric:"tabular-nums"}}>{value}</div>
          </div>
        ))}
      </div>
      {/* ── Enterprise cards + operators ────────────────────────── */}
      <div style={{display:"flex",alignItems:"stretch",gap:6,marginBottom:14}}>
        <div style={{flex:1,display:"flex"}}>
          <EntCard name="Cattle" nav="cattle" onNav={onNav} Icon={CowIcon}
            gp={r.gp} gm={r.gm} gmr={r.gp?r.gm/r.gp:0}
            oh={r.cattleOH} pl={r.cattlePL} sau={r.cattleSAU}
            color="#5C3016" bg="#FEF6EE" border="#A0612A"/>
        </div>
        <Op sym="+"/>
        <div style={{flex:1,display:"flex"}}>
          <EntCard name="Sheep" nav="sheep" onNav={onNav} Icon={SheepIcon}
            gp={r.sheep.gp} gm={r.sheep.gm} gmr={r.sheep.gmr}
            oh={r.sheepOH} pl={r.sheepPL} sau={r.sheep.sau}
            color="#5C4A32" bg="#FAF5EC" border="#A89070"/>
        </div>
        <Op sym="+"/>
        <div style={{flex:1,display:"flex"}}>
          <EntCard name="Goats" nav="goats" onNav={onNav} Icon={GoatIcon}
            gp={r.goats.gp} gm={r.goats.gm} gmr={r.goats.gmr}
            oh={r.goatOH} pl={r.goatPL} sau={r.goats.sau}
            color="#3A5028" bg="#EFF3E8" border="#6B8A52"/>
        </div>
        <Op sym="+"/>
        <div style={{flex:1,display:"flex"}}>
          <EntCard name="Leases & Hunting" nav="leases" onNav={onNav} Icon={DeerIcon}
            gp={r.leases.gp} gm={r.leases.gm} gmr={r.leases.gmr}
            oh={0} pl={r.leases.gm} sau={0}
            color="#2D4818" bg="#EDF2E0" border="#6B8A52"/>
        </div>
        <Op sym="="/>
        <div style={{flex:1,display:"flex"}}>
          <CombinedCard r={r} onNav={onNav}/>
        </div>
      </div>
      {/* ── Flow diagram ────────────────────────────────────────── */}
      <div style={{background:"white",borderRadius:10,padding:16,boxShadow:"0 2px 6px rgba(0,0,0,0.06)",marginTop:8}}>
        <div style={{textAlign:"center",marginBottom:6,paddingBottom:10,borderBottom:"1px solid #EDE8E0"}}>
          <div style={{fontSize:13,fontWeight:700,color:"#5A3E1B",letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:3}}>Profit Planning Process Flow</div>
          <div style={{fontSize:11,color:"#8B6437",fontStyle:"italic"}}>Click any box to navigate to that section</div>
        </div>
        <svg width="100%" viewBox="0 0 1155 460">
          <defs>
            <marker id="ah"  viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 1L9 5L0 9Z" fill="#A09070"/></marker>
            <marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 1L9 5L0 9Z" fill="#C0392B"/></marker>
          </defs>

          {/* ── BS Open (left) ── */}
          <g style={cs} onClick={() => onNav("bs")}>
            <rect x="15" y="175" width="130" height="72" rx="8" fill="#EDE8F5" stroke="#7B5EA7" strokeWidth="1"/>
            <text x="80" y="198" textAnchor="middle" fontSize="11" fontWeight="700" fill="#4A2D7A">Balance sheet start</text>
            <text x="80" y="218" textAnchor="middle" fontSize="10" fill="#9B7AC8">{"Livestock: " + allBIVStr}</text>
          </g>

          {/* ── BHS (above Stock Flow) ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="163" y="50" width="155" height="68" rx="8" fill="#FFF5DC" stroke="#A0832A" strokeWidth="1"/>
            <text x="240" y="71" textAnchor="middle" fontSize="11" fontWeight="700" fill="#6B5010">Breeding herd stats</text>
            <text x="240" y="87" textAnchor="middle" fontSize="10" fill="#C4993B">{cattleHd}</text>
            <text x="240" y="102" textAnchor="middle" fontSize="10" fill="#C4993B">{sheepHd}</text>
          </g>

          {/* ── BS Open → Stock Flow (arrow passes through junction circle) ── */}
          <line x1="145" y1="211" x2="163" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── BHS → junction on BS Open-Stock Flow arrow (down, left, down) ── */}
          <path d="M240 118 L240 165 L154 165 L154 211" fill="none" stroke="#A09070" strokeWidth="1.5"/>

          {/* ── Junction circle where BHS meets BS Open-Stock Flow arrow ── */}
          <circle cx="154" cy="211" r="4" fill="#A09070"/>

          {/* ── Stock Flow ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="163" y="175" width="155" height="72" rx="8" fill="#E8F0DC" stroke="#5A7A3A" strokeWidth="1"/>
            <text x="240" y="197" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2D4818">Stock flow</text>
            <text x="240" y="213" textAnchor="middle" fontSize="10" fill="#5A8830">{sfStr}</text>
            <text x="240" y="228" textAnchor="middle" fontSize="10" fill="#5A8830">{"S:" + r.sheep.bred + " bred · G:" + r.goats.bred + " bred"}</text>
          </g>

          {/* ── Stock Flow → Cash Flow arm (bottom → straight down → right) ── */}
          <path d="M240 247 L240 295 L614 295 L614 330" fill="none" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Stock Flow → Livestock Val ── */}
          <line x1="318" y1="211" x2="336" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Livestock Val ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="336" y="175" width="135" height="72" rx="8" fill="#E8F0DC" stroke="#5A7A3A" strokeWidth="1"/>
            <text x="403" y="197" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2D4818">Livestock val</text>
            <text x="403" y="213" textAnchor="middle" fontSize="10" fill="#5A8830">{"Open: " + valOpenStr}</text>
            <text x="403" y="228" textAnchor="middle" fontSize="10" fill="#5A8830">{"Close: " + valCloseStr}</text>
          </g>

          {/* ── LS Val → Trading/GP ── */}
          <line x1="471" y1="211" x2="489" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Trading / GP ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="489" y="175" width="155" height="72" rx="8" fill="#F5EAE0" stroke="#8B5A2A" strokeWidth="1"/>
            <text x="566" y="197" textAnchor="middle" fontSize="11" fontWeight="700" fill="#5A2D10">Trading / GP</text>
            <text x="566" y="213" textAnchor="middle" fontSize="10" fill="#B07040">{gpStr}</text>
            <text x="566" y="228" textAnchor="middle" fontSize="10" fill="#B07040">{"All: " + fmt(r.allGP)}</text>
          </g>

          {/* ── DC junction ● between Trading/GP and GM ── */}
          <line x1="644" y1="211" x2="652" y2="211" stroke="#A09070" strokeWidth="1.5"/>
          <circle cx="653" cy="211" r="5" fill="#C0392B"/>
          <line x1="654" y1="211" x2="662" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Gross Margin ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="662" y="175" width="145" height="72" rx="8" fill="#E3EDCE" stroke="#4A6E28" strokeWidth="1"/>
            <text x="734" y="197" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2A4010">Gross margin</text>
            <text x="734" y="213" textAnchor="middle" fontSize="10" fill="#5A8830">{gmStr}</text>
            <text x="734" y="228" textAnchor="middle" fontSize="10" fill="#5A8830">{"All: " + fmt(r.allGM) + " " + pfmt(r.gmr)}</text>
          </g>

          {/* ── OH junction ● between GM and P/L ── */}
          <line x1="807" y1="211" x2="815" y2="211" stroke="#A09070" strokeWidth="1.5"/>
          <circle cx="816" cy="211" r="5" fill="#C0392B"/>
          <line x1="817" y1="211" x2="825" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Profit / Loss ── */}
          <g style={cs} onClick={() => onNav("results")}>
            <rect x="825" y="175" width="150" height="72" rx="8" fill="#EDE4D6" stroke="#7A5A3A" strokeWidth="1"/>
            <text x="900" y="197" textAnchor="middle" fontSize="11" fontWeight="700" fill="#3D2B1A">Profit / loss</text>
            <text x="900" y="213" textAnchor="middle" fontSize="10" fill="#8A7060">{plStr}</text>
            <text x="900" y="228" textAnchor="middle" fontSize="10" fill="#8A7060">{"Biz: " + fmt(r.bizPL)}</text>
          </g>

          {/* ── P/L → BS Close ── */}
          <line x1="975" y1="211" x2="993" y2="211" stroke="#A09070" strokeWidth="1.5" markerEnd="url(#ah)"/>

          {/* ── Balance Sheet End ── */}
          <g style={cs} onClick={() => onNav("bs")}>
            <rect x="993" y="175" width="130" height="72" rx="8" fill="#EDE8F5" stroke="#7B5EA7" strokeWidth="1"/>
            <text x="1058" y="198" textAnchor="middle" fontSize="11" fontWeight="700" fill="#4A2D7A">Balance sheet end</text>
            <text x="1058" y="218" textAnchor="middle" fontSize="10" fill="#9B7AC8">{"Livestock: " + allCIVStr}</text>
          </g>

          {/* ── Cash Flow (below, receives arm from Stock Flow) ── */}
          <g style={cs} onClick={() => onNav("cattle")}>
            <rect x="614" y="330" width="240" height="110" rx="8" fill="#D5E8B8" stroke="#4A7A30" strokeWidth="1"/>
            <text x="734" y="354" textAnchor="middle" fontSize="13" fontWeight="700" fill="#1E4A0A">Cash flow</text>
            <text x="734" y="372" textAnchor="middle" fontSize="11" fill="#3D7020">{"C: " + kfmt(r.revenue)}</text>
            <text x="734" y="389" textAnchor="middle" fontSize="11" fill="#3D7020">{"S: " + kfmt(r.sheep.revenue)}</text>
            <text x="734" y="406" textAnchor="middle" fontSize="11" fill="#3D7020">{"G: " + kfmt(r.goats.revenue)}</text>
            <text x="734" y="426" textAnchor="middle" fontSize="11" fontWeight="700" fill="#2A5C10">{"All rev: " + kfmt(r.allRev)}</text>
          </g>

          {/* ── DC: FROM Cash Flow → UP to junction ● (between Trading/GP and GM) ── */}
          <line x1="653" y1="330" x2="653" y2="217" stroke="#C0392B" strokeWidth="2" strokeDasharray="5,3" markerEnd="url(#ah2)"/>
          <text x="658" y="280" textAnchor="start" fontSize="11" fontWeight="700" fill="#C0392B">{"DC: " + kfmt(dcAll)}</text>

          {/* ── OH: FROM Cash Flow → UP to junction ● (between GM and P/L) ── */}
          <line x1="816" y1="330" x2="816" y2="217" stroke="#C0392B" strokeWidth="2" strokeDasharray="5,3" markerEnd="url(#ah2)"/>
          <text x="821" y="280" textAnchor="start" fontSize="11" fontWeight="700" fill="#C0392B">{"OH: " + kfmt(r.totalOH) + " (SAU-alloc)"}</text>
        </svg>
      </div>
    </div>
  );
}

// ── Profit View Toggle (reusable) ────────────────────────────────────────────
function ProfitViewToggle({profitView, setProfitView}) {
  return (
    <div style={{display:"flex",justifyContent:"flex-end",alignItems:"center",marginBottom:12,gap:8}}>
      <span style={{fontSize:11,color:"#8B6437",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em"}}>Profit View</span>
      <div style={{display:"flex",borderRadius:20,overflow:"hidden",border:"2px solid #C4993B",background:"#F0E4C8"}}>
        <button type="button" onClick={() => setProfitView("economic")} style={{background:profitView==="economic"?T:"transparent",color:profitView==="economic"?"white":"#3D2B1A",border:"none",padding:"4px 14px",fontSize:11,fontWeight:700,cursor:"pointer",borderRadius:20}}>Economic</button>
        <button type="button" onClick={() => setProfitView("accounting")} style={{background:profitView==="accounting"?T:"transparent",color:profitView==="accounting"?"white":"#3D2B1A",border:"none",padding:"4px 14px",fontSize:11,fontWeight:700,cursor:"pointer",borderRadius:20}}>Accounting</button>
      </div>
    </div>
  );
}

// ── Column Banner (inputs vs outputs) ────────────────────────────────────────
function ColBanner({inputs}) {
  return inputs ? (
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",borderRadius:7,
                 background:"#EBF5FF",border:"2px solid #93C5FD",marginBottom:14,
                 fontSize:12,fontWeight:700,color:"#1A3A6B",letterSpacing:"0.03em"}}>
      ✏️&nbsp; Your Inputs — type or edit any highlighted field
    </div>
  ) : (
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 14px",borderRadius:7,
                 background:"#F0FDF4",border:"2px solid #86EFAC",marginBottom:14,
                 fontSize:12,fontWeight:700,color:"#166534",letterSpacing:"0.03em"}}>
      📊&nbsp; Calculated Results — updates instantly as you type
    </div>
  );
}

// ── Cattle Form ───────────────────────────────────────────────────────────────
function CattleForm({d, r, set, onNav, profitView, setProfitView}) {
  const h = d.herd;
  const setH = (f) => (v) => set("herd", f, v);
  const setV = (f) => (v) => set("val", f, v);
  const setS = (f) => (v) => set("sales", f, v);
  const setD = (f) => (v) => set("dc", f, v);
  const ohPctStr = (r.cattleShare * 100).toFixed(1) + "% share";
  const kpis = [
    {label:"Gross Product",   value:fmt(r.gp),              icon:"$",  neg:false},
    {label:"Gross Margin",    value:fmt(r.gm),              icon:"📊", neg:false},
    {label:"Enterprise P(L)", value:fmt(r.cattlePL),        icon:r.cattlePL>=0?"↑":"↓", neg:r.cattlePL<0},
    {label:"GMR",             value:pfmt(r.gp?r.gm/r.gp:0),icon:"%",  neg:false},
    {label:"Cattle SAU",      value:r.cattleSAU.toFixed(1), icon:"🐄", neg:false},
    {label:"OH Allocation",   value:fmt(r.cattleOH),        icon:"🏦", neg:false},
  ];
  const rHdr = (<div style={{display:"grid",gridTemplateColumns:"1fr 68px 68px",gap:6,padding:"6px 0 2px",borderBottom:"1px solid #F0EBE3"}}><div/><div style={{fontSize:10,color:"#8B6437",textAlign:"center",fontWeight:600}}>Head</div><div style={{fontSize:10,color:"#8B6437",textAlign:"center",fontWeight:600}}>Rate %</div></div>);
  return (
    <div>
      <ProfitViewToggle profitView={profitView} setProfitView={setProfitView}/>
      <EntHdr nm="Cattle" subtitle="Enterprise Performance & Financial Summary" AnimalIcon={CowIcon} kpis={kpis} onNav={onNav}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div>
          <ColBanner inputs={true}/>
          <Section icon="🐄" label="Herd Composition">
            <Field label="Mature Cows"             val={h.cows}   set={setH("cows")}/>
            <Field label="H2 Heifers (first-calf)" val={h.h2}    set={setH("h2")}/>
            <Field label="H1 Heifers (virgin)"     val={h.h1}    set={setH("h1")}/>
            <Field label="Bulls"                   val={h.bulls}  set={setH("bulls")}/>
          </Section>
          <Section icon="📈" label="Performance Rates">
            {rHdr}
            <RateField label="Death loss" pctVal={h.deathPct} setPct={setH("deathPct")} count={r.deaths}        base={h.cows}/>
            <RateField label="Dry rate"   pctVal={h.dryPct}   setPct={setH("dryPct")}   count={r.dry}           base={h.cows - r.deaths}/>
            <RateField label="Cull rate"  pctVal={h.cullPct}  setPct={setH("cullPct")}  count={r.culls}         base={r.wet}/>
            <RateField label="Open rate"  pctVal={h.openPct}  setPct={setH("openPct")}  count={r.open}          base={r.wet - r.culls}/>
            <Field label="H1 heifers to retain" val={h.h1Kept} set={setH("h1Kept")}/>
          </Section>
          <Section icon="💵" label="Livestock Values">
            <Field label="Preg cow / head"   val={d.val.cowPreg} set={setV("cowPreg")} pre="$"/>
            <Field label="Bull / head"       val={d.val.bull}    set={setV("bull")} pre="$"/>
            <Field label="H2 heifer / head"  val={d.val.h2}      set={setV("h2")} pre="$"/>
            <Field label="H1 heifer / head"  val={d.val.h1}      set={setV("h1")} pre="$"/>
          </Section>
          <Section icon="🏷️" label="Livestock Sales">
            <Field label="Steers sold"           val={d.sales.steersSold}   set={setS("steersSold")}/>
            <Hint>{"Biology ~" + r.bioSteers + " from " + r.wet + " wet cows"}</Hint>
            <Field label="Heifers sold"          val={d.sales.heifersSold}  set={setS("heifersSold")}/>
            <Hint>{"Biology ~" + r.bioHfSold + " after " + h.h1Kept + " retained"}</Hint>
            <Field label="Steer weight (lbs)"    val={d.sales.steerWt}      set={setS("steerWt")}/>
            <Field label="Steer price ($/lb)"    val={d.sales.steerPPLb}    set={setS("steerPPLb")} pre="$"/>
            <Field label="Heifer weight (lbs)"   val={d.sales.hfWt}         set={setS("hfWt")}/>
            <Field label="Heifer price ($/lb)"   val={d.sales.hfPPLb}       set={setS("hfPPLb")} pre="$"/>
            <Field label="Cull/open cow / head"  val={d.sales.cullCow}      set={setS("cullCow")} pre="$"/>
          </Section>
          <Section icon="💸" label="Direct Costs">
            <Field label="Opportunity rate"      val={d.dc.oppPct}   set={setD("oppPct")} suf="%"/>
            <Field label="Feed and mineral"      val={d.dc.feed}     set={setD("feed")} pre="$"/>
            <Field label="Vet and medicine"      val={d.dc.vet}      set={setD("vet")} pre="$"/>
            <Field label="Freight and marketing" val={d.dc.freight}  set={setD("freight")} pre="$"/>
          </Section>
        </div>
        <div>
          <ColBanner inputs={false}/>
          <Section icon="🔄" label="Stock Flow">
            <Row label="Wet cows (weaned a calf)" value={r.wet} bold/>
            <Row label="Preg cows at close"        value={r.pregKept} bold hi/>
            <Row label="Deaths"     value={r.deaths}/>
            <Row label="Culls"      value={r.culls}/>
            <Row label="Open"       value={r.open}/>
            <Row label="Dry"        value={r.dry}/>
            <Row label="Cattle SAU" value={r.cattleSAU.toFixed(1)}/>
          </Section>
          <Section icon="🏦" label="Trading Account">
            <Row label="BIV"             value={fmt(r.biv)}/>
            <Row label="CIV"             value={fmt(r.civ)}/>
            <Row label="Livestock sales" value={fmt(r.lsSales)} bold/>
            <Row label="Gross Product"   value={fmt(r.gp)} bold hi/>
          </Section>
          <Section icon="🧮" label="Enterprise P&L">
            <Row label="Gross Product"           value={fmt(r.gp)}/>
            <Row label="Direct Costs"            value={"(" + fmt(r.totalDC) + ")"} indent/>
            <Row label="Gross Margin"            value={fmt(r.gm)} bold/>
            <Row label={"OH (" + ohPctStr + ")"} value={"(" + fmt(r.cattleOH) + ")"} indent/>
            <Row label="Enterprise P(L)"         value={fmt(r.cattlePL)} bold hi/>
            <Row label="GMR"                     value={pfmt(r.gp ? r.gm/r.gp : 0)}/>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ── Small Ruminant Form ───────────────────────────────────────────────────────
function SRForm({d, r, set, ent, nm, femLbl, maleLbl, offLbl, entR, entOH, entShare, entPL, AnimalIcon, onNav, profitView, setProfitView}) {
  const sr = d[ent];
  const setH = (f) => (v) => set(ent, f, v, "herd");
  const setV = (f) => (v) => set(ent, f, v, "val");
  const setS = (f) => (v) => set(ent, f, v, "sales");
  const setD = (f) => (v) => set(ent, f, v, "dc");
  const ohPctStr = (entShare * 100).toFixed(1) + "% share";
  const bioHint = "Biology ~" + entR.bioOffspring + " from " + entR.wet + " wet " + femLbl.toLowerCase();
  const kpis = [
    {label:"Gross Product",   value:fmt(entR.gp),   icon:"$",  neg:false},
    {label:"Gross Margin",    value:fmt(entR.gm),   icon:"📊", neg:false},
    {label:"Enterprise P(L)", value:fmt(entPL),     icon:entPL>=0?"↑":"↓", neg:entPL<0},
    {label:"GMR",             value:pfmt(entR.gmr), icon:"%",  neg:false},
    {label:nm + " SAU",       value:entR.sau.toFixed(1), icon:"🐑", neg:false},
    {label:"OH Allocation",   value:fmt(entOH),     icon:"🏦", neg:false},
  ];
  const rateHdr = (
    <div style={{display:"grid",gridTemplateColumns:"1fr 68px 68px",gap:6,padding:"6px 0 2px",borderBottom:"1px solid #F0EBE3"}}>
      <div/><div style={{fontSize:10,color:"#8B6437",textAlign:"center",fontWeight:600}}>Head</div><div style={{fontSize:10,color:"#8B6437",textAlign:"center",fontWeight:600}}>Rate %</div>
    </div>
  );
  return (
    <div>
      <ProfitViewToggle profitView={profitView} setProfitView={setProfitView}/>
      <EntHdr nm={nm} subtitle={"Enterprise Performance & Financial Summary"} AnimalIcon={AnimalIcon} kpis={kpis} onNav={onNav}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div>
          <ColBanner inputs={true}/>
          <Section icon="🐑" label={nm + " Herd"}>
            <Field label={"Breeding " + femLbl} val={sr.herd.females}    set={setH("females")}/>
            <Field label={maleLbl}              val={sr.herd.males}      set={setH("males")}/>
            <Field label="Litter rate"          val={sr.herd.litterRate} set={setH("litterRate")}/>
          </Section>
          <Section icon="📈" label="Performance Rates">
            {rateHdr}
            <RateField label="Death loss" pctVal={sr.herd.deathPct} setPct={setH("deathPct")} count={entR.deaths}                       base={sr.herd.females}/>
            <RateField label="Dry rate"   pctVal={sr.herd.dryPct}   setPct={setH("dryPct")}   count={entR.dry}                          base={sr.herd.females - entR.deaths}/>
            <RateField label="Cull rate"  pctVal={sr.herd.cullPct}  setPct={setH("cullPct")}  count={entR.culls}                        base={entR.wet}/>
            <RateField label="Open rate"  pctVal={sr.herd.openPct}  setPct={setH("openPct")}  count={entR.open}                         base={entR.wet - entR.culls}/>
            <Field label="Replacements to keep" val={sr.herd.replacementsKept} set={setH("replacementsKept")}/>
          </Section>
          <Section icon="💵" label="Livestock Values">
            <Field label={femLbl + " per head"} val={sr.val.femalePerHead} set={setV("femalePerHead")} pre="$"/>
            <Field label={maleLbl + " per head"} val={sr.val.malePerHead}  set={setV("malePerHead")} pre="$"/>
          </Section>
          <Section icon="🏷️" label={offLbl + " Sales"}>
            <Field label={offLbl + " sold"}          val={sr.sales.offspringSold}   set={setS("offspringSold")}/>
            <Hint>{bioHint}</Hint>
            <Field label={offLbl + " weight (lbs)"}  val={sr.sales.offspringWt}     set={setS("offspringWt")}/>
            <Field label={offLbl + " price ($/lb)"}  val={sr.sales.offspringPPLb}   set={setS("offspringPPLb")} pre="$"/>
            <Field label={"Cull " + femLbl.toLowerCase() + " / head"} val={sr.sales.cullPerHead} set={setS("cullPerHead")} pre="$"/>
            <Field label="Other income"              val={sr.sales.other}           set={setS("other")} pre="$"/>
          </Section>
          <Section icon="💸" label="Direct Costs">
            <Field label="Opportunity rate"      val={sr.dc.oppPct}   set={setD("oppPct")} suf="%"/>
            <Field label="Feed and mineral"      val={sr.dc.feed}     set={setD("feed")} pre="$"/>
            <Field label="Vet and medicine"      val={sr.dc.vet}      set={setD("vet")} pre="$"/>
            <Field label="Freight and marketing" val={sr.dc.freight}  set={setD("freight")} pre="$"/>
          </Section>
        </div>
        <div>
          <Section icon="🔄" label="Stock Flow">
            <Row label={"Wet " + femLbl.toLowerCase()} value={entR.wet} bold/>
            <Row label="Bred and kept at close"        value={entR.bred} bold hi/>
            <Row label="Deaths" value={entR.deaths}/>
            <Row label="Culls"  value={entR.culls}/>
            <Row label="Open"   value={entR.open}/>
            <Row label="Dry"    value={entR.dry}/>
            <Row label="SAU"    value={entR.sau.toFixed(1)}/>
          </Section>
          <Section icon="🏦" label="Trading Account">
            <Row label="BIV"                   value={fmt(entR.biv)}/>
            <Row label="CIV"                   value={fmt(entR.civ)}/>
            <Row label={offLbl + " sales"}     value={fmt(entR.offspringSales)} indent/>
            <Row label="Cull animal sales"     value={fmt(entR.cullSales)} indent/>
            <Row label="Total livestock sales" value={fmt(entR.lsSales)} bold/>
            <Row label="Gross Product"         value={fmt(entR.gp)} bold hi/>
          </Section>
          <Section icon="🧮" label={"Enterprise P&L"}>
            <Row label="Gross Product"           value={fmt(entR.gp)}/>
            <Row label="Direct Costs"            value={"(" + fmt(entR.totalDC) + ")"} indent/>
            <Row label="Gross Margin"            value={fmt(entR.gm)} bold/>
            <Row label={"OH (" + ohPctStr + ")"} value={"(" + fmt(entOH) + ")"} indent/>
            <Row label="Enterprise P(L)"         value={fmt(entPL)} bold hi/>
            <Row label="GMR"                     value={pfmt(entR.gmr)}/>
          </Section>
        </div>
      </div>
    </div>
  );
}
// ── Overheads Form ────────────────────────────────────────────────────────────
function OHForm({d, r, set}) {
  const o = (f) => (v) => set("oh", f, v);
  const setP = (f) => (v) => set("prop", f, v);
  const cSAU = r.cattleSAU.toFixed(1) + " SAU";
  const sSAU = r.sheep.sau.toFixed(1) + " SAU";
  const gSAU = r.goats.sau.toFixed(1) + " SAU";
  const cAlloc = (r.cattleShare*100).toFixed(1) + "% . " + fmt(r.cattleOH);
  const sAlloc = (r.sheepShare*100).toFixed(1) + "% . " + fmt(r.sheepOH);
  const gAlloc = (r.goatShare*100).toFixed(1) + "% . " + fmt(r.goatOH);
  return (
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div>
        <ColBanner inputs={true}/>
        <Section icon="🌾" label="Land">
          <Field label="Acres owned"                  val={d.prop.acresOwned}  set={setP("acresOwned")} suf="ac"/>
          <Field label="Acres grazed (owned + leased)" val={d.prop.acresGrazed} set={setP("acresGrazed")} suf="ac"/>
          <Field label="Opportunity rent"             val={d.oh.oppRent}       set={o("oppRent")} pre="$"/>
          <Field label="Utilities"                    val={d.oh.util}          set={o("util")} pre="$"/>
          <Field label="Annual upkeep"                val={d.oh.upkeep}        set={o("upkeep")} pre="$"/>
          <Field label="Improvement budget"           val={d.oh.impr}          set={o("impr")} pre="$"/>
        </Section>
        <Section icon="👷" label="Labor">
          <Field label="FTE labor"              val={d.prop.ftes}    set={setP("ftes")}/>
          <Field label="Unpaid labor (imputed)" val={d.oh.unpaid}    set={o("unpaid")} pre="$"/>
          <Field label="Hired labor"            val={d.oh.hired}     set={o("hired")} pre="$"/>
        </Section>
        <Section icon="🚜" label="Machinery and Equipment">
          <Field label="Depreciation"        val={d.oh.depr}     set={o("depr")} pre="$"/>
          <Field label="Fuel"                val={d.oh.fuel}     set={o("fuel")} pre="$"/>
          <Field label="Repairs and maintenance" val={d.oh.repairs} set={o("repairs")} pre="$"/>
          <Field label="Insurance"           val={d.oh.ins}      set={o("ins")} pre="$"/>
          <Field label="Supplies"            val={d.oh.supplies} set={o("supplies")} pre="$"/>
        </Section>
        <Section icon="📋" label="Other">
          <Field label="Other overheads" val={d.oh.other} set={o("other")} pre="$"/>
        </Section>
      </div>
      <div>
        <Section icon="📊" label="Overhead Totals">
          <Row label="Land"           value={fmt(r.landOH)} indent/>
          <Row label="Labor"          value={fmt(r.laborOH)} indent/>
          <Row label="Things (V&E)"   value={fmt(r.thingsOH)} indent/>
          <Row label="Other"          value={fmt(d.oh.other)} indent/>
          <Row label="Total Overheads" value={fmt(r.totalOH)} bold/>
          <Row label="Cash Overheads"  value={fmt(r.cashOH)}/>
        </Section>
        <Section icon="🐾" label="SAU-Based Allocation">
          <Row label={"Cattle (" + cSAU + ")"} value={cAlloc}/>
          <Row label={"Sheep (" + sSAU + ")"}  value={sAlloc}/>
          <Row label={"Goats (" + gSAU + ")"}  value={gAlloc}/>
          <Row label={"Total (" + r.totalSAU.toFixed(1) + " SAU)"} value={fmt(r.totalOH)} bold/>
        </Section>
      </div>
    </div>
  );
}

// ── Balance Sheet Form ────────────────────────────────────────────────────────
const COLBS = "1.6fr 1fr 1fr";
function DualHdr() {
  return (
    <div style={{display:"grid",gridTemplateColumns:COLBS,gap:8,marginBottom:6}}>
      <div/>
      <div style={{fontSize:11,fontWeight:600,color:T,textAlign:"center",padding:"4px 0",borderRadius:4,background:"#F0E4C8"}}>Opening</div>
      <div style={{fontSize:11,fontWeight:600,color:"#185FA5",textAlign:"center",padding:"4px 0",borderRadius:4,background:"#E6F1FB"}}>Closing</div>
    </div>
  );
}
function DualGrp({label}) {
  return (
    <div style={{fontSize:10,fontWeight:700,color:"#3D2B1A",textTransform:"uppercase",letterSpacing:"0.1em",margin:"18px 0 6px",padding:"8px 10px",background:"#F8F2E8",borderRadius:6,borderLeft:"3px solid #8B6437"}}>
      {label}
    </div>
  );
}
function DualField({label, field, open, close, so, sc}) {
  const inp = (val, onChange) => (
    <div style={{display:"flex",alignItems:"center",border:"1px solid #93C5FD",borderRadius:5,padding:"3px 7px",background:"#EBF5FF"}}>
      <span style={{fontSize:11,color:"#4A7CC5",fontWeight:600,marginRight:2}}>$</span>
      <input type="number" value={val} onChange={e => onChange(+e.target.value)}
        onFocus={e => { e.target.style.outline="2px solid #3B82F6"; e.target.style.outlineOffset="1px"; }}
        onBlur={e => { e.target.style.outline="none"; }}
        style={{border:"none",outline:"none",fontSize:13,fontWeight:600,background:"transparent",color:"#1A3A6B",minWidth:0,width:"100%"}}/>
    </div>
  );
  return (
    <div style={{display:"grid",gridTemplateColumns:COLBS,gap:8,alignItems:"center",marginBottom:5}}>
      <div style={{fontSize:12,color:"var(--color-text-secondary)"}}>{label}</div>
      {inp(open[field], v => so(field, v))}
      {inp(close[field], v => sc(field, v))}
    </div>
  );
}
function DualRow({label, open, close, bold, divider}) {
  const bb = divider ? "2px solid var(--color-border-secondary)" : "1px solid var(--color-border-tertiary)";
  const cs = {fontSize:12,fontVariantNumeric:"tabular-nums",textAlign:"right",fontWeight:bold?600:400,color:"var(--color-text-primary)",padding:"4px 0",borderBottom:bb};
  return (
    <div style={{display:"grid",gridTemplateColumns:COLBS,gap:8,alignItems:"center"}}>
      <span style={{fontSize:12,fontWeight:bold?600:400,color:bold?"var(--color-text-primary)":"var(--color-text-secondary)",padding:"4px 0",borderBottom:bb}}>{label}</span>
      <span style={{...cs,background:bold?"#E0F2ED":"transparent",paddingRight:4}}>{fmt(open)}</span>
      <span style={{...cs,background:bold?"#E6F1FB":"transparent",paddingRight:4}}>{fmt(close)}</span>
    </div>
  );
}
function BSForm({d, r, set, copyOpenToClose}) {
  const o = d.bsOpen, c = d.bsClose;
  const so = (f, v) => set("bsOpen", f, v);
  const sc = (f, v) => set("bsClose", f, v);
  const nwC = r.nwChange >= 0 ? "#15803d" : "#b91c1c";
  const nwBg = r.nwChange >= 0 ? "#f0fdf4" : "#fef2f2";
  const nwBd = r.nwChange >= 0 ? "#86efac" : "#fca5a5";
  const nwTxt = r.nwChange >= 0 ? "Family wealth grew" : "Family wealth declined";
  const wcdStr = r.wcd ? Math.round(r.wcd) + "d . target >150" : "";
  const lsNote = "All livestock: Open " + fmt(r.allBIV) + " . Close " + fmt(r.allCIV);
  return (
    <div style={{background:"white",borderRadius:10,border:"1px solid #EDE8DF",boxShadow:"0 1px 5px rgba(0,0,0,0.05)",padding:"16px 18px"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
        <div style={{fontSize:13,color:"var(--color-text-secondary)"}}>{lsNote + " (flows from trading)"}</div>
        <button type="button" onClick={copyOpenToClose}
          style={{background:T,color:"white",border:"none",borderRadius:6,padding:"6px 14px",fontSize:12,cursor:"pointer",marginLeft:12}}>
          Copy Opening to Closing
        </button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:24}}>
        <div>
          <ColBanner inputs={true}/>
          <DualHdr/>
          <DualGrp label="Current Assets"/>
          <DualField label="Cash and bank" field="cash" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Accounts receivable" field="ar" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Hay and crops" field="hayCrops" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Other current" field="otherCurrent" open={o} close={c} so={so} sc={sc}/>
          <DualGrp label="Intermediate Assets (non-livestock)"/>
          <DualField label="Vehicles and trucks" field="vehicles" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Machinery and tractors" field="machinery" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Other equipment" field="equipment" open={o} close={c} so={so} sc={sc}/>
          <DualGrp label="Long-term Assets"/>
          <DualField label="Land and pasture" field="land" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Buildings" field="buildings" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Improvements" field="improvements" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Off-farm investments" field="offFarm" open={o} close={c} so={so} sc={sc}/>
          <DualGrp label="Liabilities"/>
          <DualField label="Current liabilities" field="currentLiab" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Intermediate liabilities" field="intermediateLiab" open={o} close={c} so={so} sc={sc}/>
          <DualField label="Long-term liabilities" field="longTermLiab" open={o} close={c} so={so} sc={sc}/>
          <ColBanner inputs={false}/>
          <div style={{marginTop:8}}>
            <DualHdr/>
            <DualRow label="Current Assets" open={r.bso.ca} close={r.bsc.ca}/>
            <DualRow label="All Livestock" open={r.allBIV} close={r.allCIV}/>
            <DualRow label="V and E" open={r.bso.ve} close={r.bsc.ve}/>
            <DualRow label="Intermediate Assets" open={r.bso.inter} close={r.bsc.inter}/>
            <DualRow label="Long-term Assets" open={r.bso.lt} close={r.bsc.lt}/>
            <DualRow label="TOTAL ASSETS" open={r.bso.total} close={r.bsc.total} bold divider/>
            <DualRow label="Total Liabilities" open={r.bso.liab} close={r.bsc.liab}/>
            <DualRow label="NET WORTH" open={r.bso.nw} close={r.bsc.nw} bold divider/>
          </div>
        </div>
        <div style={{width:200,flexShrink:0}}>
          <div style={{padding:14,borderRadius:8,background:nwBg,border:"1px solid " + nwBd,marginBottom:10}}>
            <div style={{fontSize:11,color:"var(--color-text-secondary)",marginBottom:4}}>Change in net worth</div>
            <div style={{fontSize:24,fontWeight:600,color:nwC,fontVariantNumeric:"tabular-nums"}}>{fmt(r.nwChange)}</div>
            <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:4}}>{nwTxt}</div>
          </div>
          <div style={{padding:"12px 14px",borderRadius:8,background:"#F0E4C8"}}>
            <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginBottom:2}}>Working capital</div>
            <div style={{fontSize:16,fontWeight:500,fontVariantNumeric:"tabular-nums"}}>{fmt(r.wc)}</div>
            {r.wcd && <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:1}}>{wcdStr}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Results Form ──────────────────────────────────────────────────────────────
function ResultsForm({d, r}) {
  const gmrC = r.gmr >= 0.70 ? "#15803d" : r.gmr >= 0.50 ? "#b45309" : "#b91c1c";
  const roaC = r.roa == null ? "#1A1208" : r.roa >= 0.10 ? "#15803d" : "#b91c1c";
  const atrC = r.atr == null ? "#1A1208" : r.atr >= 0.25 ? "#15803d" : "#b45309";
  const wcdC = r.wcd == null ? "#1A1208" : r.wcd >= 150 ? "#15803d" : "#b91c1c";
  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:20}}>
        <BC label="GMR (Combined)"       display={pfmt(r.gmr)}  color={gmrC}/>
        <BC label="Overhead Ratio"       display={pfmt(r.orate)} color={r.orate<=0.40?"#15803d":r.orate<=0.56?"#b45309":"#b91c1c"}/>
        <BC label="GP per FTE"           display={fmt(r.gpFte)}  color={r.gpFte>=400000?"#15803d":"#1A1208"}/>
        <BC label="Working Capital Days" display={r.wcd ? Math.round(r.wcd) + "d" : "—"} color={wcdC}/>
        <BC label="ROA"                  display={r.roa != null ? pfmt(r.roa) : "— (enter land value)"} color={roaC}/>
        <BC label="Asset Turnover"       display={r.atr != null ? pfmt(r.atr) : "—"} color={atrC}/>
      </div>
      <Section icon="📋" label="Enterprise P&L — SAU-Allocated Overhead">
        <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr 1fr 1fr",gap:8,padding:"8px 0 4px"}}>
          {["Enterprise","GP","GM","OH Share","Ent P(L)"].map(h => (
            <div key={h} style={{fontSize:10,fontWeight:600,color:"#9B8B7A",textTransform:"uppercase"}}>{h}</div>
          ))}
        </div>
        {[
          {name:"Cattle", gp:r.gp,       gm:r.gm,       oh:r.cattleOH, pl:r.cattlePL},
          {name:"Sheep",  gp:r.sheep.gp, gm:r.sheep.gm, oh:r.sheepOH,  pl:r.sheepPL},
          {name:"Goats",  gp:r.goats.gp, gm:r.goats.gm, oh:r.goatOH,   pl:r.goatPL},
          {name:"Leases", gp:r.leases.gp,gm:r.leases.gm,oh:0,           pl:r.leases.gm},
        ].map(e => (
          <div key={e.name} style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr 1fr 1fr",gap:8,padding:"7px 0",borderBottom:"1px solid #F0EBE3"}}>
            <span style={{fontSize:13,color:"#5A4A38"}}>{e.name}</span>
            <span style={{fontSize:13,fontVariantNumeric:"tabular-nums",color:"#1A1208"}}>{fmt(e.gp)}</span>
            <span style={{fontSize:13,fontVariantNumeric:"tabular-nums",color:"#1A1208"}}>{fmt(e.gm)}</span>
            <span style={{fontSize:13,fontVariantNumeric:"tabular-nums",color:"#1A1208"}}>{fmt(e.oh)}</span>
            <span style={{fontSize:13,fontVariantNumeric:"tabular-nums",fontWeight:600,color:e.pl>=0?"#15803d":"#b91c1c"}}>{fmt(e.pl)}</span>
          </div>
        ))}
        <div style={{display:"grid",gridTemplateColumns:"1.4fr 1fr 1fr 1fr 1fr",gap:8,padding:"8px 0",borderTop:"2px solid #E8DFD0"}}>
          {["Total",fmt(r.allGP),fmt(r.allGM),fmt(r.totalOH),fmt(r.opPL)].map((v,i) => (
            <span key={i} style={{fontSize:13,fontWeight:600,fontVariantNumeric:"tabular-nums",color:"#1A1208"}}>{v}</span>
          ))}
        </div>
      </Section>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <div>
          <Section icon="📊" label="Combined P&L">
            <Row label="Combined Gross Product" value={fmt(r.allGP)}/>
            <Row label="Combined Gross Margin"  value={fmt(r.allGM)} bold/>
            <Row label="Total Overheads"        value={"(" + fmt(r.totalOH) + ")"} indent/>
            <Row label="Operating P(L)"         value={fmt(r.opPL)} bold/>
            <Row label="Business P(L)"          value={fmt(r.bizPL)} bold hi/>
          </Section>
        </div>
        <div>
          <Section icon="💧" label="Cash and Land">
            <Row label="Total Revenue (all)"  value={fmt(r.allRev)} bold/>
            <Row label="Cash contribution"    value={fmt(r.cashNI)} bold hi/>
            {r.gpAcre && <Row label={"GP per grazed acre (" + d.prop.acresGrazed + "ac)"} value={fmt(r.gpAcre)}/>}
            {r.gmAcre && <Row label="GM per grazed acre" value={fmt(r.gmAcre)}/>}
          </Section>
          <Section icon="%" label="Individual GMR">
            <Row label="Cattle GMR" value={pfmt(r.gp ? r.gm/r.gp : 0)}/>
            <Row label="Sheep GMR"  value={pfmt(r.sheep.gmr)}/>
            <Row label="Goats GMR"  value={pfmt(r.goats.gmr)}/>
          </Section>
        </div>
      </div>
    </div>
  );
}


// ── Guide Modal ───────────────────────────────────────────────────────────────
// ── Scenario Manager ──────────────────────────────────────────────────────────
function ScenarioManager({currentData, onLoad, onClose, token, setToken}) {
  const tcRef    = useRef(null);
  const [scenarios,   setScenarios]   = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [opBusy,      setOpBusy]      = useState(false);
  const [err,         setErr]         = useState("");
  const [tab,         setTab]         = useState("list");
  const [saveName,    setSaveName]    = useState("");
  const [saveYear,    setSaveYear]    = useState(new Date().getFullYear());
  const [saveType,    setSaveType]    = useState("actual");
  const [compareIds,  setCompareIds]  = useState([]);
  const [cmpData,     setCmpData]     = useState([]);

  useEffect(() => {
    const init = () => {
      tcRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id:CLIENT_ID, scope:SCOPES,
        callback:(resp) => { if (resp.access_token) setToken(resp.access_token); }
      });
    };
    if (window.google?.accounts?.oauth2) { init(); }
    else {
      const iv = setInterval(() => { if (window.google?.accounts?.oauth2) { clearInterval(iv); init(); } }, 300);
      return () => clearInterval(iv);
    }
  }, []);

  useEffect(() => { if (token) fetchList(); }, [token]);

  const signIn = () => tcRef.current?.requestAccessToken();

  const fetchList = async () => {
    setLoading(true); setErr("");
    try { setScenarios(await driveAPI.list(token)); }
    catch(e) { setErr("Could not reach Drive — try signing in again."); }
    setLoading(false);
  };

  const handleLoad = async (fileId) => {
    setOpBusy(true); setErr("");
    try { const s = await driveAPI.load(token, fileId); onLoad(s.data); onClose(); }
    catch(e) { setErr("Load failed."); }
    setOpBusy(false);
  };

  const handleSave = async () => {
    if (!saveName.trim()) { setErr("Please enter a name."); return; }
    setOpBusy(true); setErr("");
    try {
      await driveAPI.save(token, saveName.trim(), saveType, saveYear, currentData);
      setSaveName(""); setTab("list"); await fetchList();
    } catch(e) { setErr("Save failed."); }
    setOpBusy(false);
  };

  const handleDelete = async (fileId, name) => {
    if (!confirm(`Delete "${name}"?`)) return;
    setOpBusy(true);
    try { await driveAPI.remove(token, fileId); setScenarios(s => s.filter(x => x.id !== fileId)); }
    catch(e) { setErr("Delete failed."); }
    setOpBusy(false);
  };

  const toggleCompare = (id) => {
    setCompareIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id)
        : prev.length >= 2 ? [prev[1], id] : [...prev, id]
    );
  };

  const runCompare = async () => {
    if (compareIds.length !== 2) { setErr("Select exactly 2 scenarios."); return; }
    setOpBusy(true); setErr("");
    try {
      const [a, b] = await Promise.all(compareIds.map(id => driveAPI.load(token, id)));
      setCmpData([a, b]); setTab("compare");
    } catch(e) { setErr("Could not load scenarios."); }
    setOpBusy(false);
  };

  const typeBadge = (type) => {
    const cfg = {
      actual:      {bg:"#DCFCE7",c:"#166534",lbl:"Actual"},
      plan:        {bg:"#DBEAFE",c:"#1D4ED8",lbl:"Plan"},
      theoretical: {bg:"#FEF3C7",c:"#92400E",lbl:"Theoretical"},
    };
    const s = cfg[type] || cfg.plan;
    return <span style={{background:s.bg,color:s.c,fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:10,textTransform:"uppercase",letterSpacing:"0.05em"}}>{s.lbl}</span>;
  };

  const ScenarioCard = ({s}) => (
    <div style={{background:"#FAFAF8",border:"1px solid #E5DDD0",borderRadius:8,padding:"12px 14px",marginBottom:8}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:8,marginBottom:8}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:T,marginBottom:4}}>{s.meta.name||s.name}</div>
          <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
            {typeBadge(s.meta.type)}
            {s.meta.year && <span style={{fontSize:11,color:"#9B8B7A"}}>{s.meta.year}</span>}
            <span style={{fontSize:11,color:"#9B8B7A"}}>{s.modifiedTime?new Date(s.modifiedTime).toLocaleDateString():""}</span>
          </div>
        </div>
        <label style={{display:"flex",alignItems:"center",gap:5,cursor:"pointer",flexShrink:0}}>
          <input type="checkbox" checked={compareIds.includes(s.id)} onChange={()=>toggleCompare(s.id)}
            style={{width:14,height:14,accentColor:T,cursor:"pointer"}}/>
          <span style={{fontSize:11,color:"#9B8B7A"}}>Compare</span>
        </label>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button type="button" onClick={()=>handleLoad(s.id)} disabled={opBusy}
          style={{flex:1,background:T,color:"white",border:"none",borderRadius:6,padding:"6px 0",fontSize:12,cursor:opBusy?"not-allowed":"pointer",fontWeight:600}}>
          Load
        </button>
        <button type="button" onClick={()=>handleDelete(s.id,s.meta.name||s.name)} disabled={opBusy}
          style={{background:"#FEE2E2",color:"#DC2626",border:"1px solid #FECACA",borderRadius:6,padding:"6px 12px",fontSize:12,cursor:opBusy?"not-allowed":"pointer",fontWeight:600}}>
          Delete
        </button>
      </div>
    </div>
  );

  return (
    <div style={{position:"fixed",inset:0,zIndex:200,display:"flex",justifyContent:"flex-end"}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()}
        style={{width:420,maxWidth:"95vw",background:"white",height:"100vh",display:"flex",flexDirection:"column",boxShadow:"-4px 0 24px rgba(0,0,0,0.18)"}}>
        {/* Header */}
        <div style={{background:T,padding:"14px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0}}>
          <div style={{color:"white",fontWeight:700,fontSize:15}}>💾 Scenarios</div>
          <button type="button" onClick={onClose}
            style={{background:"rgba(255,255,255,0.2)",border:"none",borderRadius:6,padding:"5px 12px",color:"white",fontSize:12,cursor:"pointer"}}>
            Close
          </button>
        </div>
        {!token ? (
          <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:32,gap:16,textAlign:"center"}}>
            <div style={{fontSize:40}}>☁️</div>
            <div style={{fontSize:15,fontWeight:600,color:T}}>Connect to Google Drive</div>
            <div style={{fontSize:13,color:"#6B5744",lineHeight:1.6,maxWidth:280}}>
              Scenarios save to your "Claude Financial" Drive folder and are accessible from any device.
            </div>
            <button type="button" onClick={signIn}
              style={{background:T,color:"white",border:"none",borderRadius:8,padding:"10px 28px",fontSize:14,fontWeight:600,cursor:"pointer",display:"flex",alignItems:"center",gap:8}}>
              🔑 Sign in with Google
            </button>
          </div>
        ) : (
          <>
            <div style={{display:"flex",borderBottom:"1px solid #E8DFD0",flexShrink:0}}>
              {[["list","📋 Saved"],["save","💾 Save"],["compare","📊 Compare"]].map(([k,lbl])=>(
                <button key={k} type="button" onClick={()=>{setTab(k);setErr("");}}
                  style={{flex:1,padding:"10px 0",border:"none",background:"transparent",cursor:"pointer",
                    fontSize:12,fontWeight:tab===k?700:400,color:tab===k?T:"#8B7060",
                    borderBottom:tab===k?"2px solid "+T:"2px solid transparent"}}>
                  {lbl}
                </button>
              ))}
            </div>
            {err && <div style={{margin:"10px 16px 0",padding:"8px 12px",background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:6,fontSize:12,color:"#DC2626"}}>{err}</div>}
            <div style={{flex:1,overflowY:"auto",padding:16}}>

              {tab==="list" && (
                <div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{fontSize:12,color:"#9B8B7A"}}>{scenarios.length} scenario{scenarios.length!==1?"s":""}</div>
                    <div style={{display:"flex",gap:8}}>
                      {compareIds.length===2 && (
                        <button type="button" onClick={runCompare} disabled={opBusy}
                          style={{background:"#DBEAFE",color:"#1D4ED8",border:"1px solid #BFDBFE",borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                          Compare ✓✓
                        </button>
                      )}
                      <button type="button" onClick={fetchList} disabled={loading}
                        style={{background:"#F0E4C8",color:T,border:"none",borderRadius:6,padding:"5px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>
                        {loading?"…":"↻"}
                      </button>
                    </div>
                  </div>
                  {loading && <div style={{textAlign:"center",padding:32,color:"#9B8B7A",fontSize:13}}>Loading…</div>}
                  {!loading && scenarios.length===0 && (
                    <div style={{textAlign:"center",padding:32,color:"#9B8B7A",fontSize:13}}>
                      No scenarios yet. Use the Save tab to save your first one.
                    </div>
                  )}
                  {scenarios.map(s => <ScenarioCard key={s.id} s={s}/>)}
                  {compareIds.length>0 && (
                    <div style={{marginTop:8,padding:"8px 12px",background:"#EBF5FF",border:"1px solid #93C5FD",borderRadius:6,fontSize:12,color:"#1A3A6B"}}>
                      {compareIds.length===1?"Select 1 more scenario to compare":"Click Compare ✓✓ above to run"}
                    </div>
                  )}
                </div>
              )}

              {tab==="save" && (
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  <div style={{fontSize:12,color:"#6B5744",lineHeight:1.6,padding:"8px 12px",background:"#FFF8EC",borderRadius:6,border:"1px solid #E8D9BE"}}>
                    Saves all current inputs as a named snapshot in your Drive folder.
                  </div>
                  <div>
                    <label style={{fontSize:12,fontWeight:600,color:T,display:"block",marginBottom:5}}>Scenario Name</label>
                    <input type="text" value={saveName} onChange={e=>setSaveName(e.target.value)}
                      placeholder="e.g. 2025 Actual, 2026 Budget…"
                      style={{width:"100%",border:"1px solid #93C5FD",borderRadius:6,padding:"8px 10px",fontSize:13,background:"#EBF5FF",color:"#1A3A6B",fontWeight:600,outline:"none",boxSizing:"border-box"}}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <label style={{fontSize:12,fontWeight:600,color:T,display:"block",marginBottom:5}}>Year</label>
                      <input type="number" value={saveYear} onChange={e=>setSaveYear(+e.target.value)}
                        style={{width:"100%",border:"1px solid #93C5FD",borderRadius:6,padding:"8px 10px",fontSize:13,background:"#EBF5FF",color:"#1A3A6B",fontWeight:600,outline:"none",boxSizing:"border-box"}}/>
                    </div>
                    <div>
                      <label style={{fontSize:12,fontWeight:600,color:T,display:"block",marginBottom:5}}>Type</label>
                      <select value={saveType} onChange={e=>setSaveType(e.target.value)}
                        style={{width:"100%",border:"1px solid #93C5FD",borderRadius:6,padding:"8px 10px",fontSize:13,background:"#EBF5FF",color:"#1A3A6B",fontWeight:600,outline:"none",boxSizing:"border-box"}}>
                        <option value="actual">Actual</option>
                        <option value="plan">Plan / Budget</option>
                        <option value="theoretical">Theoretical</option>
                      </select>
                    </div>
                  </div>
                  <button type="button" onClick={handleSave} disabled={opBusy}
                    style={{background:T,color:"white",border:"none",borderRadius:8,padding:"11px 0",fontSize:14,fontWeight:700,cursor:opBusy?"not-allowed":"pointer"}}>
                    {opBusy?"Saving…":"💾 Save to Drive"}
                  </button>
                </div>
              )}

              {tab==="compare" && cmpData.length===2 && (()=>{
                const ra = compute(cmpData[0].data,"economic");
                const rb = compute(cmpData[1].data,"economic");
                const nameA = cmpData[0].meta?.name||"A";
                const nameB = cmpData[1].meta?.name||"B";
                const rows = [
                  {label:"Gross Product",   a:fmt(ra.allGP),             b:fmt(rb.allGP)},
                  {label:"Gross Margin",    a:fmt(ra.allGM),             b:fmt(rb.allGM)},
                  {label:"GMR",             a:pfmt(ra.gmr),              b:pfmt(rb.gmr)},
                  {label:"Business P(L)",   a:fmt(ra.bizPL),             b:fmt(rb.bizPL)},
                  {label:"Cash Contrib",    a:fmt(ra.cashNI),            b:fmt(rb.cashNI)},
                  {label:"─ Cattle GP",     a:fmt(ra.gp),                b:fmt(rb.gp)},
                  {label:"─ Sheep GP",      a:fmt(ra.sheep.gp),          b:fmt(rb.sheep.gp)},
                  {label:"─ Goats GP",      a:fmt(ra.goats.gp),          b:fmt(rb.goats.gp)},
                  {label:"─ Leases GP",     a:fmt(ra.leases.gp),         b:fmt(rb.leases.gp)},
                  {label:"Total Overheads", a:fmt(ra.totalOH),           b:fmt(rb.totalOH)},
                  {label:"Cattle SAU",      a:ra.cattleSAU.toFixed(1),   b:rb.cattleSAU.toFixed(1)},
                  {label:"Net Worth Δ",     a:fmt(ra.nwChange),          b:fmt(rb.nwChange)},
                ];
                return (
                  <div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                      {[cmpData[0],cmpData[1]].map((s,i)=>(
                        <div key={i} style={{padding:"8px 10px",borderRadius:7,background:i===0?"#FFF8EC":"#EBF5FF",border:`1px solid ${i===0?"#E8D9BE":"#93C5FD"}`}}>
                          <div style={{fontSize:10,fontWeight:700,color:"#9B8B7A",textTransform:"uppercase"}}>{i===0?"A":"B"}</div>
                          <div style={{fontSize:12,fontWeight:700,color:T,marginTop:2}}>{s.meta?.name}</div>
                          <div style={{marginTop:3}}>{typeBadge(s.meta?.type)}{" "}<span style={{fontSize:11,color:"#9B8B7A"}}>{s.meta?.year}</span></div>
                        </div>
                      ))}
                    </div>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead>
                        <tr style={{borderBottom:"2px solid #E5DDD0"}}>
                          <th style={{textAlign:"left",padding:"5px 4px",color:"#9B8B7A",fontWeight:600,fontSize:11}}>Metric</th>
                          <th style={{textAlign:"right",padding:"5px 4px",color:T,fontWeight:700,fontSize:11}}>{nameA}</th>
                          <th style={{textAlign:"right",padding:"5px 4px",color:"#1D4ED8",fontWeight:700,fontSize:11}}>{nameB}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(({label,a,b},i)=>(
                          <tr key={i} style={{borderBottom:"1px solid #F0EBE3",background:i%2===0?"transparent":"#FAFAF8"}}>
                            <td style={{padding:"6px 4px",color:"#5A4A38"}}>{label}</td>
                            <td style={{padding:"6px 4px",textAlign:"right",fontVariantNumeric:"tabular-nums",fontWeight:600,color:T}}>{a}</td>
                            <td style={{padding:"6px 4px",textAlign:"right",fontVariantNumeric:"tabular-nums",fontWeight:600,color:"#1D4ED8"}}>{b}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={()=>{setTab("list");setCompareIds([]);setCmpData([]);}}
                      style={{marginTop:14,width:"100%",background:"#F0E4C8",color:T,border:"none",borderRadius:6,padding:"8px 0",fontSize:12,fontWeight:600,cursor:"pointer"}}>
                      ← Back to list
                    </button>
                  </div>
                );
              })()}
              {tab==="compare" && cmpData.length===0 && (
                <div style={{textAlign:"center",padding:32,color:"#9B8B7A",fontSize:13}}>
                  Go to the Saved tab, check two scenarios, then click Compare.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GuideContent() {
  const S = (title, body) => (
    <div style={{marginBottom:22}}>
      <div style={{fontSize:13,fontWeight:600,color:T,marginBottom:6,paddingBottom:5,borderBottom:"2px solid #DEC99A"}}>{title}</div>
      <div style={{fontSize:13,color:"var(--color-text-secondary)",lineHeight:1.75}}>{body}</div>
    </div>
  );
  const tips = [
    "The small ? icons next to any term show its definition on hover while you work.",
    "The header bar always shows GMR (Gross Margin Ratio) and Business P(L) — the two most useful at-a-glance numbers.",
    "Values update live as you type — there is no save button.",
    "Livestock BIV and CIV flow automatically into the Balance Sheet — no double entry needed.",
    "GMR and Overhead Ratio are the two most important benchmarks to watch. Target GMR >= 70%, OR <= 40%.",
    "SAU allocation means each enterprise carries its fair share of shared overhead. Changing herd size shifts the allocation automatically.",
    "When you click into an input field showing a comma-formatted number, it temporarily shows the raw number for easy editing. The comma returns when you click away.",
  ];
  return (
    <div>
      {S("Overview", "The Ranch Profit Planner follows the Ranching for Profit (RFP) model. It tracks three enterprises — Cattle, Sheep, and Goats — each with its own trading account and direct costs, all sharing a common overhead pool. The cascade flows: Gross Product → Gross Margin → Enterprise P(L) → Business P(L).")}
      {S("Home Screen", "Shows all three enterprises at a glance with key metrics per enterprise and combined totals. Tap any enterprise card to enter or edit data for that enterprise. The flow diagram shows the full RFP cascade with live values for all three enterprises at each step.")}
      {S("Cattle / Sheep / Goats", "Each enterprise section contains herd stats, livestock values, actual sale quantities, and direct costs. The right column shows computed results immediately. Biological suggestions (from herd stats) are shown as hints beneath sale quantity fields — these are guides only, not locked values.")}
      {S("Overheads", "Enter shared costs once: land (opportunity rent, utilities, upkeep), labor (unpaid and hired), and machinery (depreciation, fuel, repairs). These are automatically split between all three enterprises in proportion to their SAU count. The Overheads tab shows the exact dollar allocation per enterprise.")}
      {S("Balance Sheet", "Enter opening and closing values for assets and liabilities. All livestock values flow in automatically from each enterprise's trading account — no double entry. Use 'Copy Opening to Closing' to pre-fill the closing side, then adjust for anything that changed during the year (equipment sold, debt paid down, etc.). ROA and ATR benchmarks in Results require land and equipment values here.")}
      {S("Results & Benchmarks", "Shows all RFP benchmarks: GMR, Overhead Ratio, GP/FTE, Working Capital Days, ROA, and ATR. Also shows the enterprise P(L) comparison table (how each enterprise performed after overhead allocation) and the combined business P(L). Green = on target, amber = close, red = needs attention.")}
      {S("Tips for Getting the Most Out of It",
        <div>{tips.map((t,i) => <div key={i} style={{marginBottom:7,display:"flex",gap:8}}><span style={{color:T,flexShrink:0}}>•</span><span>{t}</span></div>)}</div>
      )}
    </div>
  );
}

const LIVESTOCK_TERMS = new Set(["SAU","Cattle SAU","Wet cows (weaned a calf)","Preg cows at close","Open","Dry","Culls","Bred and kept at close"]);
const PINNED_TERMS = ["Gross Product","Gross Margin","Gross Margin Ratio","Cash Contribution"];
function GlossaryContent() {
  const allTerms = Object.entries(TIPS).sort((a,b) => a[0].localeCompare(b[0]));
  const pinned = PINNED_TERMS.map(k => [k, TIPS[k]]).filter(([,v]) => v);
  const pinnedSet = new Set(PINNED_TERMS);
  const financial = allTerms.filter(([k]) => !LIVESTOCK_TERMS.has(k) && !pinnedSet.has(k));
  const livestock = allTerms.filter(([k]) => LIVESTOCK_TERMS.has(k));
  const TermList = ({terms}) => (
    <>
      {terms.map(([term, def]) => (
        <div key={term} style={{marginBottom:14,paddingBottom:14,borderBottom:"1px solid var(--color-border-tertiary)"}}>
          <div style={{fontSize:13,fontWeight:600,color:T,marginBottom:3}}>{term}</div>
          <div style={{fontSize:12,color:"var(--color-text-secondary)",lineHeight:1.65}}>{def}</div>
        </div>
      ))}
    </>
  );
  const CatHeader = ({icon, label, pinTop}) => (
    <div style={{fontSize:12,fontWeight:700,color:pinTop?"#5A3E1B":"white",background:pinTop?"#F0E4C8":T,borderRadius:6,padding:"6px 12px",marginBottom:12,marginTop:pinTop?0:8,letterSpacing:"0.05em",textTransform:"uppercase",border:pinTop?"2px solid #C4993B":"none"}}>
      {icon} {label}
    </div>
  );
  return (
    <div>
      <div style={{fontSize:12,color:"var(--color-text-tertiary)",marginBottom:16,padding:"8px 12px",background:"#F0E4C8",borderRadius:6}}>
        {allTerms.length} terms defined. These same definitions appear as hover tooltips (the ? icons) throughout the app.
      </div>
      <CatHeader icon="⭐" label="Core Concepts" pinTop={true}/>
      <TermList terms={pinned}/>
      <CatHeader icon="💰" label="Financial Terminology"/>
      <TermList terms={financial}/>
      <CatHeader icon="🐄" label="Livestock Terminology"/>
      <TermList terms={livestock}/>
    </div>
  );
}

function GuideModal({onClose}) {
  const [tab, setTab] = useState("guide");
  return (
    <div
      style={{position:"fixed",inset:0,zIndex:2000,background:"rgba(0,0,0,0.45)",display:"flex",alignItems:"stretch",justifyContent:"flex-end"}}
      onClick={onClose}>
      <div
        style={{background:"#FFFBF4",width:"min(520px, 100vw)",display:"flex",flexDirection:"column",boxShadow:"-4px 0 32px rgba(0,0,0,0.3)"}}
        onClick={e => e.stopPropagation()}>
        <div style={{background:T,padding:"14px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{fontSize:17,fontWeight:600,color:"white"}}>Guide and Definitions</div>
          <button type="button" onClick={onClose}
            style={{background:"rgba(255,255,255,0.2)",border:"none",borderRadius:6,padding:"5px 12px",color:"white",fontSize:13,cursor:"pointer"}}>
            Close
          </button>
        </div>
        <div style={{display:"flex",borderBottom:"1px solid var(--color-border-tertiary)",flexShrink:0}}>
          {[["guide","How to Use"],["glossary","Glossary"]].map(([key,lbl]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              style={{padding:"10px 20px",border:"none",background:"transparent",cursor:"pointer",fontSize:13,fontWeight:tab===key?600:400,color:tab===key?T:"var(--color-text-secondary)",borderBottom:tab===key?"2px solid "+T:"2px solid transparent",flexShrink:0}}>
              {lbl}
            </button>
          ))}
        </div>
        <div style={{padding:20,overflowY:"auto",flex:1}}>
          {tab === "guide" ? <GuideContent/> : <GlossaryContent/>}
        </div>
      </div>
    </div>
  );
}


// ── Leases & Hunting Form ─────────────────────────────────────────────────────
function LeasesForm({d, r, set, profitView, setProfitView, onNav}) {
  const l = d.leases;
  const sI = (f) => (v) => set("leases", f, v, "income");
  const sD = (f) => (v) => set("leases", f, v, "dc");
  const kpis = [
    {label:"Gross Product",  value:fmt(r.leases.gp),              icon:"$",  neg:false},
    {label:"Gross Margin",   value:fmt(r.leases.gm),              icon:"📊", neg:r.leases.gm<0},
    {label:"GMR",            value:pfmt(r.leases.gmr),            icon:"%",  neg:false},
    {label:"Direct Costs",   value:fmt(r.leases.totalDC),         icon:"💸", neg:false},
    {label:"GM to P(L)",     value:fmt(r.leases.gm),              icon:r.leases.gm>=0?"↑":"↓", neg:r.leases.gm<0},
    {label:"OH Allocation",  value:"None",                        icon:"🏦", neg:false},
  ];
  return (
    <div>
      <ProfitViewToggle profitView={profitView} setProfitView={setProfitView}/>
      <EntHdr nm="Leases & Hunting" subtitle="Enterprise Performance & Financial Summary" AnimalIcon={DeerIcon} kpis={kpis} onNav={onNav} largeIcon={true}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div>
        <ColBanner inputs={true}/>
        <Section icon="🏕️" label="Lease Income">
          <Field label="Hunting lease"             val={l.income.hunting} set={sI("hunting")} pre="$"/>
          <Field label="Grazing lease (third party)" val={l.income.grazing} set={sI("grazing")} pre="$"/>
          <Field label="Camping and recreation"    val={l.income.camping} set={sI("camping")} pre="$"/>
          <Field label="Other lease income"        val={l.income.other}   set={sI("other")} pre="$"/>
        </Section>
        <Section icon="💸" label="Direct Costs">
          <Field label="Property maintenance" val={l.dc.maintenance} set={sD("maintenance")} pre="$"/>
          <Field label="Wildlife management"  val={l.dc.wildlife}    set={sD("wildlife")} pre="$"/>
          <Field label="Other costs"          val={l.dc.other}       set={sD("other")} pre="$"/>
        </Section>
        <div style={{padding:"12px 14px",borderRadius:8,background:"#F8F2E8",border:"1px solid #E8DFD0",fontSize:12,color:"#4A2C0A",lineHeight:1.7}}>
          This enterprise carries no overhead allocation. The land costs are already borne by the livestock enterprises through opportunity rent. Lease GM flows directly into the combined operating P(L).
        </div>
      </div>
      <div>
        <ColBanner inputs={false}/>
        <Section icon="🧮" label="Enterprise Summary">
          <Row label="Hunting income"          value={fmt(l.income.hunting)} indent/>
          <Row label="Grazing income"          value={fmt(l.income.grazing)} indent/>
          <Row label="Camping and recreation"  value={fmt(l.income.camping)} indent/>
          <Row label="Other income"            value={fmt(l.income.other)} indent/>
          <Row label="Gross Product"           value={fmt(r.leases.gp)} bold hi/>
          <Row label="Direct Costs"            value={"(" + fmt(r.leases.totalDC) + ")"} indent/>
          <Row label="Gross Margin"            value={fmt(r.leases.gm)} bold hi/>
          <Row label="GMR"                     value={pfmt(r.leases.gmr)}/>
        </Section>
        <div style={{padding:"12px 14px",borderRadius:8,background:"#EDF2E0",border:"1px solid #6B8A52",fontSize:12,color:"#2D4818",lineHeight:1.7}}>
          <strong>GM contribution to combined P(L):</strong> {fmt(r.leases.gm)}
        </div>
      </div>
    </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
const TABS = [
  {key:"cattle",  label:"Cattle"},
  {key:"sheep",   label:"Sheep"},
  {key:"goats",   label:"Goats"},
  {key:"leases",  label:"Leases & Hunting"},
  {key:"oh",      label:"Overheads"},
  {key:"bs",      label:"Balance Sheet"},
  {key:"results", label:"Results"},
];

export default function App() {
  const [data, setData] = useState(INIT);
  const [view, setView] = useState("home");
  const [profitView, setProfitView] = useState("economic");
  const [showGuide, setShowGuide] = useState(false);
  const [showScenarios, setShowScenarios] = useState(false);
  const [driveToken, setDriveToken] = useState(null);
  const r = useMemo(() => compute(data, profitView), [data, profitView]);

  const set = (sec, field, val, sub) => {
    if (sub) {
      setData(p => ({...p, [sec]: {...p[sec], [sub]: {...p[sec][sub], [field]: val}}}));
    } else {
      setData(p => ({...p, [sec]: {...p[sec], [field]: val}}));
    }
  };
  const copyOtoC = () => setData(p => ({...p, bsClose: {...p.bsOpen}}));

  const tabLabel = TABS.find(t => t.key === view);

  const renderMain = () => {
    if (view === "home")    return <HomeScreen r={r} d={data} onNav={setView} profitView={profitView} setProfitView={setProfitView}/>;
    if (view === "cattle")  return <div style={WS}><CattleForm d={data} r={r} set={set} onNav={setView} profitView={profitView} setProfitView={setProfitView}/></div>;
    if (view === "sheep")   return <div style={WS}><SRForm d={data} r={r} set={set} ent="sheep" nm="Sheep" femLbl="Ewes" maleLbl="Rams" offLbl="Lambs" entR={r.sheep} entOH={r.sheepOH} entShare={r.sheepShare} entPL={r.sheepPL} AnimalIcon={SheepIcon} onNav={setView} profitView={profitView} setProfitView={setProfitView}/></div>;
    if (view === "goats")   return <div style={WS}><SRForm d={data} r={r} set={set} ent="goats" nm="Goats" femLbl="Does" maleLbl="Bucks" offLbl="Kids" entR={r.goats} entOH={r.goatOH} entShare={r.goatShare} entPL={r.goatPL} AnimalIcon={GoatIcon} onNav={setView} profitView={profitView} setProfitView={setProfitView}/></div>;
    if (view === "leases")  return <div style={WS}><LeasesForm d={data} r={r} set={set} profitView={profitView} setProfitView={setProfitView} onNav={setView}/></div>;
    if (view === "oh")      return <div style={WS}><OHForm d={data} r={r} set={set}/></div>;
    if (view === "bs")      return <div style={WS}><BSForm d={data} r={r} set={set} copyOpenToClose={copyOtoC}/></div>;
    if (view === "results") return <div style={WS}><ResultsForm d={data} r={r}/></div>;
    return <div style={{padding:20}}>Unknown view</div>;
  };

  return (
    <div style={{fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",minHeight:"100vh",background:"#FAF5EC"}}>
      {showGuide && <GuideModal onClose={() => setShowGuide(false)}/>}
      {showScenarios && (
        <ScenarioManager
          currentData={data}
          onLoad={(d) => setData(d)}
          onClose={() => setShowScenarios(false)}
          token={driveToken}
          setToken={setDriveToken}
        />
      )}
      <div style={{background:T,padding:"12px 24px",display:"flex",alignItems:"center",gap:14,position:"sticky",top:0,zIndex:10,boxShadow:"0 2px 8px rgba(0,0,0,0.25)"}}>
        <img src="data:image/png;base64,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" alt="Eubanks Cattle Co" style={{height:58,width:"auto",flexShrink:0,borderRadius:4}}/>
        <div style={{display:"flex",flexDirection:"column",gap:1}}>
          <div style={{fontSize:19,fontWeight:700,color:"white",letterSpacing:"-0.02em",lineHeight:1.1}}>Ranch Profit Planner</div>
          <div style={{fontSize:11,color:"rgba(255,255,255,0.65)",fontWeight:500,letterSpacing:"0.03em",textTransform:"uppercase"}}>Eubanks Cattle Co · RFP Model</div>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:12,alignItems:"center",flexShrink:0}}>
          <button type="button" onClick={() => setShowScenarios(true)}
            style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.35)",borderRadius:7,padding:"6px 14px",color:"white",fontSize:12,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:14}}>💾</span> Scenarios
          </button>
          <button type="button" onClick={() => setShowGuide(true)}
            style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.35)",borderRadius:7,padding:"6px 14px",color:"white",fontSize:12,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:14}}>📖</span> Guide &amp; Definitions
          </button>
        </div>
      </div>
      {view !== "home" && (
        <div style={{background:"white",borderBottom:"1px solid #E8DFD0",padding:"0 20px",display:"flex",overflowX:"auto",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <button type="button" onClick={() => setView("home")}
            style={{padding:"10px 14px",border:"none",borderBottom:"2px solid transparent",background:"transparent",color:"#8B7060",fontSize:13,cursor:"pointer",fontWeight:400,whiteSpace:"nowrap",flexShrink:0,display:"flex",alignItems:"center",gap:5}}>
            🏠 Home
          </button>
          <div style={{width:1,background:"#E8DFD0",margin:"8px 4px"}}/>
          {TABS.map(t => (
            <button key={t.key} type="button" onClick={() => setView(t.key)}
              style={{padding:"10px 14px",border:"none",borderBottom:view===t.key?"2px solid " + T:"2px solid transparent",background:"transparent",color:view===t.key?T:"#8B7060",fontSize:13,cursor:"pointer",fontWeight:view===t.key?600:400,whiteSpace:"nowrap",flexShrink:0}}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div style={{padding:16,maxWidth:1100,margin:"0 auto"}}>
        {renderMain()}
      </div>
    </div>
  );
}
