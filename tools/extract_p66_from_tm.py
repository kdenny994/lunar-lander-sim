# Extract the Apollo 11 P66 reconstruction (NASA/TM-20220007267 Fig. 14) from vector paths.
import re,sys,json
s=open(sys.argv[1]).read()
blue=[]
for a in re.findall(r'<path ([^>]*)/>',s):
    if '44.99' not in a: continue
    d=re.search(r' d="([^"]*)"',a).group(1)
    blue.append([(float(x),float(y)) for x,y in re.findall(r'(-?[\d.]+) (-?[\d.]+)',d)])
cols={0:318.0,1:1998.0,2:3678.0}; TSPAN=1043.5
rows={'A':(2030,2769.5),'B':(1070,1809.5),'C':(110,850)}
# (row,col): name, (raw_y0,val0), (raw_y1,val1)
axes={('A',0):('x_ft',(2276.5,0),(2769.5,2000)),
      ('A',1):('h_ft',(2030,0),(2687.5,400)),
      ('A',2):('theta_deg',(2178,0),(2769.5,20)),
      ('B',0):('xdot_fps',(1809.5,0),(1070,-50)),
      ('B',1):('hdot_fps',(1624.5,0),(1070,-15)),
      ('B',2):('q_dps',(1563,0),(1070,-10))}
series={}
for p in blue:
    x0=p[0][0]; ys=[q[1] for q in p]
    col=min(cols,key=lambda c:abs(x0-cols[c]) if x0>=cols[c]-5 else 1e9)
    row=[r for r,(a,b) in rows.items() if a-60<=min(ys) and max(ys)<=b+60][0]
    series.setdefault((row,col),[]).extend(p)
out={}
for k,(name,(r0,v0),(r1,v1)) in axes.items():
    pts=sorted(series[k])
    tv=[((px-cols[k[1]])/TSPAN*140.0, v0+(py-r0)*(v1-v0)/(r1-r0)) for px,py in pts]
    out[name]=tv
# resample at 0.2 s
import bisect
def interp(tv,t):
    ts=[a for a,_ in tv]; i=bisect.bisect_left(ts,t)
    if i<=0: return tv[0][1]
    if i>=len(tv): return tv[-1][1]
    (ta,va),(tb,vb)=tv[i-1],tv[i]
    return va if tb==ta else va+(vb-va)*(t-ta)/(tb-ta)
tmax=min(tv[-1][0] for tv in out.values())
N=int(tmax/0.2)+1
res={'source':'NASA/TM-20220007267 (Miller, Grauer, Pei, Nelson 2022), Fig. 14, extracted from vector paths',
     't0_get':'102:43:20','dt':0.2,'units':{'x_ft':'range to site, ft','h_ft':'ft','theta_deg':'pitch, deg','xdot_fps':'ft/s','hdot_fps':'ft/s','q_dps':'deg/s'}}
for name,tv in out.items(): res[name]=[round(interp(tv,i*0.2),3) for i in range(N)]
res['t']=[round(i*0.2,1) for i in range(N)]
json.dump(res,open(sys.argv[2],'w'))
for name in out: print(name, res[name][0], res[name][len(res[name])//2], res[name][-1], len(res[name]))
