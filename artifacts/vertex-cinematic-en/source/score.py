"""Original score "Signal Path" — 120 BPM, D minor resolving to F major, 33 s.

Fully procedural: additive pads, plucks, bells, synthesized drums and noise sweeps.
No samples, recordings, voice services or network calls. Hits are placed on the
picture's cut points (see story.json).
"""
from pathlib import Path
import math
import wave
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SR, DURATION, BPM = 48000, 33, 120
BEAT = 60 / BPM
N = SR * DURATION
RNG = np.random.default_rng(2611)

DRY = np.zeros((N, 2), np.float32)    # drums, bass
PADS = np.zeros((N, 2), np.float32)   # ducked by the kick
SEND = np.zeros((N, 2), np.float32)   # reverb send
KICKENV = np.zeros(N, np.float32)


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def place(bus, w, start, gain=1.0, pan=0.0):
    i = int(round(start * SR))
    if i >= N:
        return
    if i < 0:
        w, i = w[-i:], 0
    n = min(len(w), N - i)
    l, r = math.sqrt((1 - pan) / 2), math.sqrt((1 + pan) / 2)
    bus[i:i + n, 0] += w[:n] * gain * l
    bus[i:i + n, 1] += w[:n] * gain * r


def tvec(d):
    return np.arange(int(d * SR), dtype=np.float32) / SR


def onepole(x, cut):
    """Time-varying one-pole low-pass; cut is an array (Hz) or scalar."""
    cut = np.broadcast_to(np.asarray(cut, np.float32), x.shape)
    a = 1 - np.exp(-2 * np.pi * cut / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def pad_note(m, d, attack=.7, release=1.0, bright=.35):
    t = tvec(d + release)
    env = np.minimum(t / attack, 1) * np.clip((d + release - t) / release, 0, 1)
    out = np.zeros_like(t)
    for det in (-.0035, .0035):
        f = hz(m) * (1 + det)
        for n in range(1, 11):
            out += np.sin(2 * np.pi * f * n * t + n * det * 900) * (1 / n) * math.exp(-n * bright)
    trem = 1 + .06 * np.sin(2 * np.pi * .23 * t)
    return out * env * trem * .16


def pluck(m, d=.6, decay=7.0):
    t = tvec(d)
    f = hz(m)
    env = np.minimum(t / .003, 1) * np.exp(-t * decay)
    tone = sum(np.sin(2 * np.pi * f * n * t) * math.exp(-n * .7) * (1 / n) for n in range(1, 7))
    return tone * env


def bell(m, d=2.2):
    t = tvec(d)
    f = hz(m)
    parts = [(1, 1, 2.2), (2.76, .45, 4.0), (5.4, .22, 7.0), (2.0, .3, 3.0)]
    return sum(a * np.sin(2 * np.pi * f * k * t) * np.exp(-t * dc) for k, a, dc in parts) * np.minimum(t / .002, 1) * .5


def kick(start, gain=1.0):
    t = tvec(.6)
    f = 46 + 95 * np.exp(-t * 32)
    ph = 2 * np.pi * np.cumsum(f) / SR
    w = np.sin(ph) * np.exp(-t * 6.5) + .25 * np.exp(-t * 300) * RNG.standard_normal(len(t)).astype(np.float32)
    place(DRY, w, start, .9 * gain)
    i = int(start * SR)
    env = np.exp(-tvec(.35) * 9)
    n = min(len(env), N - i)
    KICKENV[i:i + n] = np.maximum(KICKENV[i:i + n], env[:n] * gain)


def clap(start, gain=1.0):
    t = tvec(.35)
    noise = RNG.standard_normal(len(t)).astype(np.float32)
    noise = np.diff(noise, prepend=0)
    env = sum(np.exp(-np.maximum(t - o, 0) * 60) * (t >= o) for o in (0, .011, .022)) + .4 * np.exp(-t * 14)
    w = noise * env * .22
    place(DRY, w, start, gain, .1)
    place(SEND, w, start, .25 * gain)


def hat(start, gain=1.0, pan=0.0):
    t = tvec(.08)
    n = RNG.standard_normal(len(t)).astype(np.float32)
    n = np.diff(np.diff(n, prepend=0), prepend=0)
    place(DRY, n * np.exp(-t * 70) * .05, start, gain, pan)


def whoosh(start, d, rise=True, gain=1.0):
    t = tvec(d)
    p = t / d
    cut = 300 + 7000 * (p ** 2 if rise else (1 - p) ** 2)
    shape = (p ** 1.6) * np.minimum((d - t) / .05, 1) if rise else np.minimum(t / .03, 1) * (1 - p) ** 1.5
    for ch, pan in ((0, -.6), (1, .6)):
        n = RNG.standard_normal(len(t)).astype(np.float32)
        w = onepole(n, cut) * shape * .5
        place(DRY, w, start, gain * .7, pan)
        place(SEND, w, start, gain * .5, pan)


def impact(start, gain=1.0):
    t = tvec(2.5)
    f = 38 + 60 * np.exp(-t * 18)
    ph = 2 * np.pi * np.cumsum(f) / SR
    boom = np.sin(ph) * np.exp(-t * 2.2)
    n = RNG.standard_normal(len(t)).astype(np.float32)
    air = onepole(n, 1800 * np.exp(-t * 3) + 200) * np.exp(-t * 4) * .8
    place(DRY, boom, start, .95 * gain)
    place(DRY, air, start, .5 * gain)
    place(SEND, air + boom * .2, start, .6 * gain)
    KICKENV[int(start * SR):int(start * SR) + SR // 2] = np.maximum(KICKENV[int(start * SR):int(start * SR) + SR // 2], np.exp(-tvec(.5) * 5))


def ping(m, start, gain=1.0, pan=0.0):
    t = tvec(.5)
    w = (np.sin(2 * np.pi * hz(m) * t) + .3 * np.sin(2 * np.pi * hz(m) * 2.01 * t)) * np.exp(-t * 14) * np.minimum(t / .002, 1)
    place(DRY, w, start, .12 * gain, pan)
    place(SEND, w, start, .18 * gain, pan)


def tick(start, freq=3200, gain=1.0, pan=0.0):
    t = tvec(.03)
    w = np.sin(2 * np.pi * freq * t) * np.exp(-t * 300)
    place(DRY, w, start, .1 * gain, pan)


# ---------- harmony ----------
CHORDS = {
    'Dm9': (38, [57, 60, 64, 65]),
    'Bbmaj9': (34, [57, 60, 62, 65]),
    'Fmaj7': (41, [57, 60, 64, 69]),
    'C69': (36, [55, 60, 62, 64]),
    'Fadd9': (41, [53, 57, 60, 67, 72]),
}
PROG = ['Dm9', 'Bbmaj9', 'Fmaj7', 'C69']
bars = [(b * 2.0, PROG[b % 4]) for b in range(14)] + [(28.0, 'Bbmaj9'), (30.0, 'Fadd9')]
for i, (start, name) in enumerate(bars):
    bass, voicing = CHORDS[name]
    d = 3.0 if name == 'Fadd9' else 2.0
    soft = .55 if start < 4 else (.75 if 20 <= start < 24 else .62)
    for k, m in enumerate(voicing):
        place(PADS, pad_note(m, d, release=1.6 if name == 'Fadd9' else .9), start, soft, (-.35, .35, -.15, .15, 0)[k])
        place(SEND, pad_note(m, d), start, soft * .35)
    # sub
    t = tvec(d + .3)
    sub = np.sin(2 * np.pi * hz(bass) * t) * np.minimum(t / .25, 1) * np.clip((d + .3 - t) / .3, 0, 1)
    place(PADS, sub, start, .28 if start < 28 else .34)

# ---------- 0–4: signal ----------
whoosh(0.0, 1.45, rise=True, gain=.9)
whoosh(1.45, 1.2, rise=False, gain=.5)
bell(81, 2.5)
place(SEND, bell(81), .45, .35)
place(DRY, bell(81), .45, .12, -.3)
place(SEND, bell(84), 1.35, .32)
place(DRY, bell(84), 1.35, .1, .3)
place(SEND, bell(88), 2.3, .2)
whoosh(3.2, .8, rise=True, gain=.6)

# ---------- groove ----------
for b in range(int(4 / BEAT), int(28 / BEAT)):
    s = b * BEAT
    if 20 <= s < 24:
        if b % 4 == 0:
            kick(s, .55)
        continue
    sec = s
    kick(sec, .8 if sec < 8 else 1.0)
    if sec >= 8 and b % 2 == 1:
        clap(sec, .7 if sec < 12 else 1.0)
# hats
for k in range(int(8 / (BEAT / 4)), int(28 / (BEAT / 4))):
    s = k * BEAT / 4
    if 20 <= s < 24:
        continue
    accent = 1.0 if k % 4 == 2 else .45
    hat(s, accent * (.7 if s < 12 else 1.0), .25 if k % 2 else -.25)
# pulse bass on 8ths
for k in range(int(4 / (BEAT / 2)), int(28 / (BEAT / 2))):
    s = k * BEAT / 2
    if 20 <= s < 24:
        continue
    name = PROG[int(s // 2) % 4]
    root = CHORDS[name][0] + 12
    t = tvec(.24)
    f = hz(root)
    w = (np.sin(2 * np.pi * f * t) + .45 * np.sin(2 * np.pi * 2 * f * t) + .2 * np.sin(2 * np.pi * 3 * f * t)) * np.exp(-t * 9) * np.minimum(t / .004, 1)
    place(DRY, w, s, .2 if k % 2 else .26)
# arps 8–12 and 24–28
for lo, hi in ((8, 12), (24, 28)):
    for k in range(int(lo / (BEAT / 4)), int(hi / (BEAT / 4))):
        s = k * BEAT / 4
        voicing = CHORDS[PROG[int(s // 2) % 4]][1]
        m = voicing[(k * 3) % len(voicing)] + 12
        w = pluck(m, .4, 11)
        place(DRY, w, s, .07, .5 if k % 2 else -.5)
        place(SEND, w, s, .06)

# ---------- 4–8: bridge ----------
impact(4.0, .55)
for k in range(8):
    ping(88 + (k % 3) * 2, 5.2 + k * .4, .8, -.4 + (k % 3) * .4)

# ---------- 12–16: capabilities hits ----------
impact(12.0, .5)
stab_notes = [74, 76, 77, 79, 81, 79, 84]
for i, m in enumerate(stab_notes):
    s = 12 + i * BEAT
    voicing = CHORDS[PROG[int(s // 2) % 4]][1]
    for v in voicing:
        place(DRY, pluck(v + 12, .5, 9), s, .06, 0)
    place(SEND, bell(m, 1.2), s, .16)
    place(DRY, bell(m, 1.2), s, .06)
whoosh(15.2, .8, rise=True, gain=.5)

# ---------- 16–20: resilience ----------
impact(16.0, .45)
for d, m in ((0, 61), (.07, 62)):
    t = tvec(.35)
    w = np.sign(np.sin(2 * np.pi * hz(m) * t)) * np.exp(-t * 10) * .05
    place(DRY, onepole(w.astype(np.float32), 2500), 17.0 + d, .6, -.2)
for i, m in enumerate([77, 81, 84, 88]):
    ping(m, 18.2 + i * .12, .9, .3)
place(SEND, bell(89, 2), 18.4, .25)
place(DRY, bell(89, 2), 18.4, .08, .3)

# ---------- 20–24: edge ----------
impact(20.0, .6)
for i in range(10):
    tick(20.15 + i * .1 * (1 - i * .04), 2600 - i * 120, .9, (i % 2 - .5) * .4)
for k in range(12):
    ping(93 - (k % 4) * 3, 20.25 + k * .24, .5, (k % 5 - 2) * .25)

# ---------- 24–28: models ----------
impact(24.0, .45)
for i in range(14):
    tick(24.1 + i * .12, 1800, .5, .3)
tick(25.9, 2400, 1.2, -.2)
tick(26.6, 2600, 1.2, .2)
whoosh(26.4, 1.6, rise=True, gain=1.0)

# ---------- 28–33: finale ----------
impact(28.0, 1.0)
place(SEND, bell(84, 3), 28.8, .3)
place(SEND, bell(88, 3), 29.15, .25)
place(SEND, bell(91, 3), 29.9, .2)
place(DRY, bell(84, 3), 28.8, .08)

# ---------- reverb & mix ----------
ir_len = int(3.2 * SR)
t = np.arange(ir_len) / SR
ir = np.stack([RNG.standard_normal(ir_len) * np.exp(-t / .85) for _ in range(2)], 1).astype(np.float32)
ir[: int(.012 * SR)] = 0
ir /= np.sqrt((ir ** 2).sum(0, keepdims=True))
size = 1 << int(np.ceil(np.log2(N + ir_len)))
wet = np.stack([np.fft.irfft(np.fft.rfft(SEND[:, c], size) * np.fft.rfft(ir[:, c], size), size)[:N] for c in range(2)], 1)

duck = 1 - .45 * np.clip(KICKENV, 0, 1)
mix = DRY + PADS * duck[:, None] + wet.astype(np.float32) * .9
fade = np.ones(N, np.float32)
fs = int(2.2 * SR)
fade[-fs:] = np.linspace(1, 0, fs) ** 2
fade[: int(.05 * SR)] = np.linspace(0, 1, int(.05 * SR))
mix *= fade[:, None]
mix = np.tanh(mix / (np.abs(mix).max() * .9) * 1.4) * .9

out = ROOT / 'assets' / 'original-score.wav'
out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), 'wb') as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SR)
    f.writeframes((np.clip(mix, -1, 1) * 32767).astype('<i2').tobytes())
print('wrote', out)
