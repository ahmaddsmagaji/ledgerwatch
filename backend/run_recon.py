from app.core.database import SessionLocal
from app.models.tables import Order, Settlement, BankTransaction, Match, ReconException, MatchTier, ExceptionType, ExceptionStatus
db = SessionLocal()
db.query(Match).delete(); db.query(ReconException).delete(); db.commit()
orders = db.query(Order).all(); settlements = db.query(Settlement).all(); banks = db.query(BankTransaction).all()
from collections import defaultdict
by_pay = defaultdict(list)
for s in settlements: by_pay[s.order_ref].append(s)
matched = 0
for o in orders:
    lst = by_pay.get(o.order_ref, [])
    if not lst:
        db.add(ReconException(type=ExceptionType.MISSING_SETTLEMENT, status=ExceptionStatus.OPEN, order_id=o.id, amount_at_risk_kobo=o.amount_kobo, evidence=f"Order {o.order_ref} {o.amount_kobo}k has no settlement"))
        continue
    exact = [s for s in lst if s.gross_kobo == o.amount_kobo]
    if exact:
        db.add(Match(tier=MatchTier.EXACT_REFERENCE, order_id=o.id, settlement_id=exact[0].id)); matched += 1
        for dup in exact[1:]:
            db.add(ReconException(type=ExceptionType.DUPLICATE, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=dup.id, amount_at_risk_kobo=dup.gross_kobo, evidence=f"Duplicate settlement {dup.processor_ref} for {o.order_ref} {dup.gross_kobo}k"))
        for s in lst:
            if s not in exact:
                db.add(ReconException(type=ExceptionType.AMOUNT_MISMATCH, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=s.id, amount_at_risk_kobo=abs(o.amount_kobo - s.gross_kobo), evidence=f"Order {o.order_ref} {o.amount_kobo}k vs settlement {s.processor_ref} {s.gross_kobo}k"))
    else:
        for s in lst:
            db.add(ReconException(type=ExceptionType.AMOUNT_MISMATCH, status=ExceptionStatus.OPEN, order_id=o.id, settlement_id=s.id, amount_at_risk_kobo=abs(o.amount_kobo - s.gross_kobo), evidence=f"Order {o.order_ref} {o.amount_kobo}k vs settlement {s.processor_ref} {s.gross_kobo}k"))
db.commit()
order_pays = {o.order_ref for o in orders}
for s in settlements:
    if s.order_ref not in order_pays:
        db.add(ReconException(type=ExceptionType.NEEDS_REVIEW, status=ExceptionStatus.OPEN, settlement_id=s.id, amount_at_risk_kobo=s.gross_kobo, evidence=f"Orphan settlement {s.processor_ref} for unknown {s.order_ref} {s.gross_kobo}k"))
sett_by_id = {s.processor_ref: s for s in settlements}
for b in banks:
    ref = None
    for sid in sett_by_id:
        if sid in (b.narration or ""): ref = sid; break
    if ref is None:
        db.add(ReconException(type=ExceptionType.ORPHAN_BANK_CREDIT, status=ExceptionStatus.OPEN, bank_txn_id=b.id, amount_at_risk_kobo=b.amount_kobo, evidence=f"Orphan bank {b.bank_ref} {b.amount_kobo}k :: {b.narration}"))
    elif sett_by_id[ref].net_kobo != b.amount_kobo:
        db.add(ReconException(type=ExceptionType.FEE_DISCREPANCY, status=ExceptionStatus.OPEN, settlement_id=sett_by_id[ref].id, bank_txn_id=b.id, amount_at_risk_kobo=abs(sett_by_id[ref].net_kobo - b.amount_kobo), evidence=f"Bank {b.bank_ref} {b.amount_kobo}k vs settlement {ref} net {sett_by_id[ref].net_kobo}k"))
db.commit()
print(f"TOTAL {len(orders)} / MATCHED {matched} / EXCEPTIONS {db.query(ReconException).count()}")
for e in db.query(ReconException).all():
    print(f" - [{e.type.value}] {e.evidence}")
db.close()
