"""Review queue: settlement lines the engine could not explain become 'needs review'
exceptions that carry the likely candidates, so a person sees them instead of the
engine staying silent.

Deterministic rules only. Nothing here decides a match; it only suggests candidates.
It never reads the answer key.
"""

from collections import Counter

from app.matching.classifier import ClassifyResult, Finding, classify, naira, normalize_ref
from app.matching.engine import MATCH_WINDOW_DAYS
from app.models.tables import ExceptionType

CANDIDATE_WINDOW_DAYS = 45  # wider than the automatic window: these are suggestions only
MAX_CANDIDATES = 5


def _candidates(line, open_orders):
    """Open orders this line might belong to. A reference match (ignoring case,
    spaces and hyphens) beats an amount-and-date match."""
    ref_key = normalize_ref(line.order_ref) if line.order_ref else ""
    found = [o for o in open_orders if ref_key and normalize_ref(o.ref) == ref_key]
    basis = "reference"
    if not found:
        basis = "amount_and_date"
        found = [
            o
            for o in open_orders
            if o.amount_kobo == line.gross_kobo
            and 0 <= (line.settled_on - o.ordered_on).days <= CANDIDATE_WINDOW_DAYS
        ]
    found.sort(key=lambda o: (abs((line.settled_on - o.ordered_on).days), o.id))
    return basis, found[:MAX_CANDIDATES]


def _why_not_linked(line, order, another_line_claims_it):
    reasons = []
    if order.amount_kobo != line.gross_kobo:
        reasons.append(
            f"the settled gross is {naira(line.gross_kobo)} but the order is {naira(order.amount_kobo)}"
        )
    lag = (line.settled_on - order.ordered_on).days
    if lag < 0:
        reasons.append(f"it settled {-lag} days before the order was placed")
    elif lag > MATCH_WINDOW_DAYS:
        reasons.append(
            f"it settled {lag} days after the order, outside the {MATCH_WINDOW_DAYS}-day automatic window"
        )
    if another_line_claims_it:
        reasons.append("another unexplained line quotes the same reference")
    if not reasons:
        reasons.append("more than one equally good fit existed, so the engine would not guess")
    return reasons


def classify_with_review(orders, lines, bank, order_links, bank_links) -> ClassifyResult:
    """classify(), plus a 'needs review' exception for every settlement line it could not explain."""
    result = classify(orders, lines, bank, order_links, bank_links)
    linked_orders = set(order_links.values())
    open_orders = [o for o in orders if o.id not in linked_orders]
    line_by_id = {s.id: s for s in lines}
    unexplained = sorted(result.unclassified_settlement_ids)

    claims = Counter(
        normalize_ref(line_by_id[i].order_ref) for i in unexplained if line_by_id[i].order_ref
    )

    review = []
    surfaced_order_ids = set()
    for line_id in unexplained:
        s = line_by_id[line_id]
        basis, found = _candidates(s, open_orders)
        quoted = s.order_ref or "no reference"
        shared = bool(s.order_ref) and claims[normalize_ref(s.order_ref)] > 1
        refs = ", ".join(o.ref for o in found)

        candidates = []
        for o in found:
            surfaced_order_ids.add(o.id)
            candidates.append(
                {
                    "order_ref": o.ref,
                    "order_amount_kobo": o.amount_kobo,
                    "amount_matches": o.amount_kobo == s.gross_kobo,
                    "days_after_order": (s.settled_on - o.ordered_on).days,
                }
            )

        if len(found) == 1 and basis == "reference":
            why = "; ".join(_why_not_linked(s, found[0], shared))
            summary = (
                f"Settlement line quoting '{quoted}' looks like order {found[0].ref} (the reference "
                f"matches once case, spaces and hyphens are ignored) but was not linked "
                f"automatically: {why}. A person should confirm."
            )
        elif found and basis == "reference":
            summary = (
                f"Settlement line quoting '{quoted}' matches {len(found)} open orders by reference "
                f"({refs}). A person should decide which one it pays."
            )
        elif found:
            summary = (
                f"Settlement line quoting '{quoted}' has no reference match, but {len(found)} open "
                f"order(s) have the same amount within {CANDIDATE_WINDOW_DAYS} days: {refs}. "
                f"A person should decide."
            )
        else:
            summary = (
                f"Settlement line quoting '{quoted}' matches no open order by reference or by amount "
                f"within {CANDIDATE_WINDOW_DAYS} days, so {naira(s.net_kobo)} arrived with nothing "
                f"to explain it."
            )

        evidence = {
            "quoted_reference": s.order_ref,
            "match_basis": basis if found else "none",
            "gross_kobo": s.gross_kobo,
            "net_kobo": s.net_kobo,
            "settled_on": s.settled_on.isoformat(),
            "candidates": candidates,
            "summary": summary,
        }
        review.append(
            Finding(
                ExceptionType.NEEDS_REVIEW,
                found[0].id if len(found) == 1 else None,
                s.id,
                bank_links.get(s.id),
                s.net_kobo,
                evidence,
            )
        )

    # An order that is a candidate in a review item is not reported as "missing":
    # it is listed inside the review item for a person to confirm.
    kept = [
        f
        for f in result.findings
        if not (f.type == ExceptionType.MISSING_SETTLEMENT and f.order_id in surfaced_order_ids)
    ]
    result.findings = kept + review
    return result
