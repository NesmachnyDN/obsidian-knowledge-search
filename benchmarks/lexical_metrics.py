"""Metrics fixed by corpus/v1/README.md, independent of retrieval."""
import math
from statistics import mean


def metrics(ranked, labels, k):
    positives = sum(grade > 0 for grade in labels.values())
    if not positives:
        return None
    grades = [labels.get(key, 0) for key in ranked[:k]]
    hits = sum(grade > 0 for grade in grades)
    dcg = lambda values: sum((2**grade - 1) / math.log2(i + 2)
                              for i, grade in enumerate(values))
    ideal = dcg(sorted(labels.values(), reverse=True)[:k])
    return {'recall': hits / positives, 'precision': hits / k,
            'ndcg': dcg(grades) / ideal,
            'mrr': next((1 / i for i, grade in enumerate(grades, 1) if grade), 0.0),
            'direct_hit': int(2 in grades)}


def score(ranked, labels):
    doc_labels = {}
    for (path, _), grade in labels.items():
        doc_labels[path] = max(grade, doc_labels.get(path, 0))
    docs = list(dict.fromkeys(path for path, _ in ranked))
    return {unit: {str(k): metrics(keys, grades, k) for k in (5, 10)}
            for unit, keys, grades in (('span', ranked, labels),
                                      ('document', docs, doc_labels))}


def summarize(rows):
    positive = [r for r in rows if not r['unanswerable']]
    negative = [r for r in rows if r['unanswerable']]
    result = {'queries': len(rows), 'positive': len(positive),
              'unanswerable': len(negative),
              'unanswerable_with_hits': sum(bool(r['ranked']) for r in negative),
              'unanswerable_hits_at_10': sum(min(10, len(r['ranked'])) for r in negative)}
    for unit in ('span', 'document'):
        result[unit] = {}
        for k in ('5', '10'):
            result[unit][k] = {
                metric: mean(r['metrics'][unit][k][metric] for r in positive)
                for metric in ('recall', 'precision', 'ndcg', 'mrr')}
            exact = [r for r in positive if r['exact']]
            result[unit][k]['exact_direct_hit'] = (
                mean(r['metrics'][unit][k]['direct_hit'] for r in exact) if exact else None)
            result[unit][k]['exact_query_count'] = len(exact)
    return result
