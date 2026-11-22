"""Build the Apollo 11 PDI-to-touchdown reference profile.

PDI -> P66 (TFI 0-615 s): Bennett, NASA TM X-58040 (1970), Table I (premission powered-descent
  event summary: inertial velocity, altitude rate, altitude at each event), retimed to the flown
  event times in Table IV (PDI 102:33:05, throttle recovery 102:39:31, P64 102:41:32, P66 102:43:20).
P66 -> touchdown (TFI 615-753 s): Miller, Grauer, Pei, Nelson, NASA/TM-20220007267 (2022), Fig. 14
  (reconstructed range x, altitude h, pitch theta at 5 Hz), extracted from the PDF vector paths.
Output: public/data/apollo11_trajectory.json with downrange-to-touchdown d (m), altitude h (m above
landing-site radius), and P66 pitch, sampled every 0.2 s from PDI.
"""
import json, numpy as np
from scipy.interpolate import PchipInterpolator, CubicHermiteSpline
FT = 0.3048
R_MOON = 1737400.0
tm = json.load(open("data-raw/p66_tm.json"))
T_P66 = 615.0  # 102:43:20 - 102:33:05
X_TD_FT = tm["x_ft"][-1]  # TM range at touchdown (range is to the original P64 target)
# Bennett Table I: TFI s, inertial velocity fps, altitude rate fps, altitude ft
tab = [(0, 5560, -4, 48814), (26, 5529, -3, 48725), (176, 4000, -50, 44934), (258, 3065, -89, 39201),
       (384, 1456, -106, 24639), (402, 1315, -127, 22644), (506, 506, -145, 7515)]
# Flown: throttle recovery at 386 s (6:26), P64/high gate at 507 s (8:27). Shift knots after 384 s by +1..+2 s.
retime = {384: 386, 402: 404, 506: 507}
ts = np.array([retime.get(t, t) for t, *_ in tab], float)
V = np.array([v for _, v, _, _ in tab], float); hd = np.array([x for _, _, x, _ in tab], float); h = np.array([x for *_, x in tab], float)
# Horizontal speed relative to the surface: inertial horizontal + Moon rotation (~15 fps at the site; the
# orbit is retrograde) - consistent with Table I touchdown (-15 inertial = 0 relative) and low gate (55 -> 68).
u = np.sqrt(np.maximum(V ** 2 - hd ** 2, 0)) + 15.0
# P66 start state from the TM reconstruction
h66 = tm["h_ft"][0]; hd66 = tm["hdot_fps"][0]
x = np.array(tm["x_ft"]); u66 = -(x[10] - x[0]) / 2.0  # ft/s toward the site
ts_all = np.append(ts, T_P66); h_all = np.append(h, h66); hd_all = np.append(hd, hd66); u_all = np.append(u, u66)
H = CubicHermiteSpline(ts_all, h_all, hd_all)
dt = 0.2
t1 = np.arange(0, T_P66 + 1e-9, dt)
h_t = H(t1)
# Horizontal speed. Braking phase is flown at known thrust (13 % trim for 26 s, then fixed throttle until
# throttle recovery), so shape the deceleration by F/m(t) from the rocket equation and scale it to hit the
# Table I velocities exactly; the throttled approach phase uses a monotone spline through the knots.
G0, ISP, FMAX, M0 = 9.80665, 305.0, 46706.0, 14950.0
def mass_at(t):
    m = M0 - 0.13 * FMAX / (ISP * G0) * min(t, 26.0)
    if t > 26: m -= 0.925 * FMAX / (ISP * G0) * (t - 26.0)
    return m
U_tail = PchipInterpolator(ts_all[4:], u_all[4:])  # from throttle recovery (386 s) on
t_rec = ts_all[4]
def accel_shape(t):
    return (0.13 if t < 26 else 0.925) * FMAX / mass_at(t)
fine = np.arange(0, t_rec + 1e-9, 0.05)
shape = np.array([accel_shape(t) for t in fine])
u_fine = np.empty_like(fine)
# segment-wise scaling between Table I knots inside the braking phase (0, 26, 176, 258, 386)
knots = [0.0, 26.0, 176.0, 258.0, t_rec]
kv = [u_all[0], u_all[1], u_all[2], u_all[3], u_all[4]]
for a, b, va, vb in zip(knots[:-1], knots[1:], kv[:-1], kv[1:]):
    sel = (fine >= a - 1e-9) & (fine <= b + 1e-9)
    tt = fine[sel]; sh = shape[sel]
    cum = np.concatenate([[0], np.cumsum((sh[1:] + sh[:-1]) / 2 * np.diff(tt))])
    u_fine[sel] = va + (vb - va) * cum / cum[-1]
def U(t):
    t = np.asarray(t, float)
    return np.where(t <= t_rec, np.interp(t, fine, u_fine), U_tail(np.maximum(t, t_rec)))
# ground-track speed at the surface: scale by R/(R+h)
g_t = U(t1) * (R_MOON / (R_MOON + h_t * FT))
d66 = (tm["x_ft"][0] - X_TD_FT)  # ft from touchdown at P66 start
# integrate backwards from P66
cum = np.concatenate([[0], np.cumsum((g_t[1:] + g_t[:-1]) / 2 * dt)])
d_t = d66 + (cum[-1] - cum)
# P66 segment
t2 = T_P66 + np.array(tm["t"][1:])
d2 = np.array(tm["x_ft"][1:]) - X_TD_FT
h2 = np.array(tm["h_ft"][1:])
th2 = np.array(tm["theta_deg"][1:])
T = np.concatenate([t1, t2]); D = np.concatenate([d_t, d2]) * FT; Hh = np.concatenate([h_t, h2]) * FT
TH = np.concatenate([np.full(len(t1), np.nan), th2])
print("PDI downrange to touchdown: %.1f km (%.1f nmi); touchdown TFI %.1f s" % (D[0] / 1000, D[0] / 1852, T[-1]))
events = [("102:17:17", "Acquisition of data"), ("102:32:55", "Altitude 50,000 ft"),
          ("102:32:58", "Ullage (RCS +X)"), ("102:33:05", "PDI - descent engine ignition (P63)"),
          ("102:33:31", "Fixed throttle position"), ("102:36:57", "Yaw to windows-up in progress"),
          ("102:37:51", "Landing radar data good"), ("102:37:59", "Windows-up maneuver complete"),
          ("102:38:22", "1202 program alarm"), ("102:38:45", "Radar updates enabled"),
          ("102:39:02", "1202 program alarm"), ("102:39:31", "Throttle recovery"),
          ("102:41:32", "P64 - high gate, approach phase"), ("102:41:37", "Landing radar antenna to position 2"),
          ("102:42:18", "1201 program alarm"), ("102:42:19", "Landing radar low scale (<2,500 ft)"),
          ("102:42:43", "1202 program alarm"), ("102:42:58", "1202 program alarm"),
          ("102:43:09", "Landing point redesignation"), ("102:43:20", "P66 - Armstrong takes manual control (410 ft)"),
          ("102:44:28", "DPS low-level light (≈ 60 s)"), ("102:45:40", "Contact light / engine off - The Eagle has landed")]
def tfi(g):
    hh, mm, ss = map(float, g.split(":")); return hh * 3600 + mm * 60 + ss - (102 * 3600 + 33 * 60 + 5)
ev = [dict(get=g, tfi=round(tfi(g), 1), label=l) for g, l in events]
json.dump(dict(
    pdiGET="102:33:05", dt=dt, t=[round(v, 1) for v in T], d=[round(v, 2) for v in D], h=[round(v, 2) for v in Hh],
    theta=[None if np.isnan(v) else round(float(v), 2) for v in TH], tP66=T_P66, events=ev,
    landing=dict(lat=0.67416, lon=23.47314, note="Tranquility Base (LM descent stage) located in LROC NAC orthophoto M150361817"),
    approachAzimuthDeg=270.0,
    sources=["F. V. Bennett, Apollo Lunar Descent and Ascent Trajectories, NASA TM X-58040, 1970 (Tables I and IV)",
             "L. J. Miller, J. A. Grauer, J. Pei, S. L. Nelson, Reconstruction of the Apollo 11 Moon Landing Final Descent Trajectory, NASA/TM-20220007267, 2022 (Fig. 14)"]),
    open("public/data/apollo11_trajectory.json", "w"))
for k in [0, 130, 880, 1290, 1930, 2535, 3075, len(T) - 1]:
    print("t=%6.1f d=%9.0f m h=%8.0f m" % (T[k], D[k], Hh[k]))
