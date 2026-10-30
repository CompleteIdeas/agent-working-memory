"""
Experiment 2, scoring: fit the abstention gate on SYNTHETIC probes only (no labels from a
human), then test it on the REAL labelled probes it has never seen.

  python tests/realstore-eval/abstention-synthetic-eval.py
"""
import json, math, os, tempfile, importlib.util

T = tempfile.gettempdir()
syn = json.load(open(os.path.join(T, 'awm-synthetic-calibration.json'), encoding='utf-8'))
real = json.load(open(os.path.join(T, 'awm-abstention-features.json'), encoding='utf-8'))

import runpy
ns = runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'abstention-combined.py'), run_name='lib')
fit, feats, logit, auc = ns['fit'], ns['feats'], ns['logit'], ns['auc']

def describe(xs, f):
    v = sorted(f(r) for r in xs)
    q = lambda p: v[min(len(v) - 1, int(p * len(v)))]
    return f"p25 {q(.25):.3f}  median {q(.5):.3f}  p75 {q(.75):.3f}  p90 {q(.9):.3f}"

rr = lambda r: r['rr1']
print('top reranker score, synthetic vs real (does synthetic noise look like real absence?)')
for name, xs in [('synthetic null-mixed', [r for r in syn if r['pop'] == 'syn-null-mixed']),
                 ('synthetic null-random', [r for r in syn if r['pop'] == 'syn-null-random']),
                 ('REAL absent-familiar', [r for r in real if r['pop'] == 'absent-familiar']),
                 ('REAL absent-new', [r for r in real if r['pop'] == 'absent-new']),
                 ('synthetic pos (gold #1)', [r for r in syn if r['pop'] == 'syn-pos' and r['top1Correct']]),
                 ('REAL answerable (gold #1)', [r for r in real if r['pop'] == 'answerable' and r['top1Correct']])]:
    print(f"  {name:28} n={len(xs):3}  {describe(xs, rr)}")

A = [r for r in real if r['pop'] == 'answerable']
N = [r for r in real if r['pop'] == 'absent-new']
F = [r for r in real if r['pop'] == 'absent-familiar']
correct = [r for r in A if r['top1Correct']]

for which in ('reranker', 'reranker+vector', 'reranker+vector+margin'):
    pos = [r for r in syn if r['pop'] == 'syn-pos']
    neg = [r for r in syn if r['pop'] != 'syn-pos']
    s = fit([feats(r, which) for r in pos + neg], [1] * len(pos) + [0] * len(neg))
    sc = lambda r: s(feats(r, which))
    print(f"\n{which}, fitted on synthetic only -> REAL AUC: absent-new {auc([sc(r) for r in A], [sc(r) for r in N]):.3f} | "
          f"absent-familiar {auc([sc(r) for r in A], [sc(r) for r in F]):.3f}")
    syn_correct = sorted(sc(r) for r in pos if r['top1Correct'])
    for target in (0.99, 0.98, 0.95):
        thr = syn_correct[int((1 - target) * len(syn_correct))]
        speaks = lambda r: r['n'] > 0 and sc(r) >= thr
        k = sum(speaks(r) for r in correct)
        print(f"   threshold to keep {int(target*100)}% of SYNTHETIC correct answers -> REAL: correct kept {k}/{len(correct)} ({100*k/len(correct):.1f}%) | "
              f"absent silenced: new {sum(not speaks(r) for r in N)}/{len(N)}, familiar {sum(not speaks(r) for r in F)}/{len(F)}")
