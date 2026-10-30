"""
Experiment 1: does combining the reranker (on its logit scale) with vector similarity separate
absent from answerable better than the reranker alone — especially the hard "familiar" case?

Reads the per-probe signals saved by abstention-features.ts. No new recalls.
Two-fold cross-validation: the model is fitted on one half of every population and scored on
the other half, then the halves swap. Thresholds are chosen ON THE TRAINING HALF to keep a target
share of correct answers, then applied unchanged to the test half — so nothing is tuned on the
probes it is scored on.

  python tests/realstore-eval/abstention-combined.py [path to awm-abstention-features.json]
"""
import json, math, os, sys, tempfile

path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), 'awm-abstention-features.json')
recs = json.load(open(path, encoding='utf-8')) if path and os.path.exists(path) else []

def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))

def feats(r, which):
    f = {
        'reranker': [logit(r['rr1'])],
        'reranker+vector': [logit(r['rr1']), r['vec1']],
        'reranker+vector+margin': [logit(r['rr1']), r['vec1'], logit(r['rr1']) - logit(r['rr2'])],
    }[which]
    return f

def fit(X, y, iters=3000, lr=0.1, l2=1e-3):
    # Plain logistic regression by gradient descent, features standardised on the training set.
    n, d = len(X), len(X[0])
    mu = [sum(x[j] for x in X) / n for j in range(d)]
    sd = [math.sqrt(sum((x[j] - mu[j]) ** 2 for x in X) / n) or 1 for j in range(d)]
    Z = [[(x[j] - mu[j]) / sd[j] for j in range(d)] for x in X]
    w = [0.0] * d; b = 0.0
    # Balance the classes: absent probes are a minority.
    pos = sum(y); neg = n - pos
    cw = {1: n / (2 * pos), 0: n / (2 * neg)}
    for _ in range(iters):
        gw = [0.0] * d; gb = 0.0
        for z, t in zip(Z, y):
            p = 1 / (1 + math.exp(-(sum(wj * zj for wj, zj in zip(w, z)) + b)))
            e = (p - t) * cw[t]
            for j in range(d): gw[j] += e * z[j]
            gb += e
        w = [wj - lr * (gj / n + l2 * wj) for wj, gj in zip(w, gw)]
        b -= lr * gb / n
    return lambda x: sum(wj * (xj - m) / s for wj, xj, m, s in zip(w, x, mu, sd)) + b

def auc(pos, neg):
    wins = sum(1.0 if a > c else 0.5 if a == c else 0.0 for a in pos for c in neg)
    return wins / (len(pos) * len(neg))

if __name__ == '__main__':
    pops = {k: [r for r in recs if r['pop'] == k] for k in ('answerable', 'absent-new', 'absent-familiar')}
    folds = [{k: v[i::2] for k, v in pops.items()} for i in (0, 1)]

    print(f"n: answerable {len(pops['answerable'])} | absent-new {len(pops['absent-new'])} | absent-familiar {len(pops['absent-familiar'])}")
    for which in ('reranker', 'reranker+vector', 'reranker+vector+margin'):
        out = {'auc_new': [], 'auc_fam': []}
        keep_rows = []
        for tr_i, te_i in ((0, 1), (1, 0)):
            tr, te = folds[tr_i], folds[te_i]
            Xtr = [feats(r, which) for k in tr for r in tr[k]]
            ytr = [1 if k == 'answerable' else 0 for k in tr for r in tr[k]]
            s = fit(Xtr, ytr)
            sc = lambda r: s(feats(r, which))
            out['auc_new'].append(auc([sc(r) for r in te['answerable']], [sc(r) for r in te['absent-new']]))
            out['auc_fam'].append(auc([sc(r) for r in te['answerable']], [sc(r) for r in te['absent-familiar']]))
            # Thresholds chosen on TRAIN to keep a share of the correct answers there.
            train_correct = sorted(sc(r) for r in tr['answerable'] if r['top1Correct'])
            for target in (0.99, 0.98, 0.95, 0.90):
                thr = train_correct[int((1 - target) * len(train_correct))]
                speaks = lambda r: r['n'] > 0 and sc(r) >= thr
                test_correct = [r for r in te['answerable'] if r['top1Correct']]
                keep_rows.append((target,
                    sum(speaks(r) for r in test_correct), len(test_correct),
                    sum(not speaks(r) for r in te['absent-new']), len(te['absent-new']),
                    sum(not speaks(r) for r in te['absent-familiar']), len(te['absent-familiar'])))
        print(f"\n{which}:  AUC vs absent-new {sum(out['auc_new'])/2:.3f} | vs absent-familiar {sum(out['auc_fam'])/2:.3f}  (2-fold, held out)")
        for target in (0.99, 0.98, 0.95, 0.90):
            rows = [r for r in keep_rows if r[0] == target]
            k, kn, sn, nn, sf, nf = (sum(r[i] for r in rows) for i in range(1, 7))
            print(f"   gate set to keep {int(target*100)}% of correct answers on train -> on held-out: correct kept {k}/{kn} ({100*k/kn:.1f}%) | "
                  f"absent silenced: new {sn}/{nn} ({100*sn/nn:.0f}%), familiar {sf}/{nf} ({100*sf/nf:.0f}%)")
