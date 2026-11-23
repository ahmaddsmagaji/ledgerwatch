import csv, os
from datetime import datetime, date
from app.core.database import SessionLocal
from app.models.tables import Order, Settlement, BankTransaction
def parse_date(s):
    s = (s or "").strip()
    if not s: return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"):
        try: return datetime.strptime(s, fmt)
        except: pass
    return datetime.fromisoformat(s)
def parse_amount(v):
    v = str(v or "0").replace(",", "").strip()
    try: f = float(v)
    except: return 0
    return int(f) if f > 10000 or "." not in v else int(f * 100)
db = SessionLocal()
with open("data/demo_orders.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("orders columns:", r.fieldnames)
    added = skipped = 0
    for row in r:
        ref = (row.get("order_id") or row.get("order_ref") or "").strip()
        if not ref: continue
        if db.query(Order).filter(Order.order_ref == ref).first(): skipped += 1; continue
        amt = parse_amount(row.get("amount_kobo") or row.get("amount"))
        dt = parse_date(row.get("order_date") or row.get("ordered_at") or row.get("date")) or datetime.now()
        db.add(Order(order_ref=ref, customer_name=(row.get("customer_name") or row.get("customer") or "Customer").strip(), amount_kobo=amt, ordered_at=dt)); added += 1
    db.commit(); print(f"orders: added={added} skipped_existing={skipped}")
with open("data/demo_settlements.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("settlements columns:", r.fieldnames)
    added = skipped = 0
    for row in r:
        ref = (row.get("payment_reference") or row.get("processor_ref") or "").strip()
        if not ref: continue
        if db.query(Settlement).filter(Settlement.processor_ref == ref).first(): skipped += 1; continue
        gross = parse_amount(row.get("gross_kobo") or row.get("amount_kobo") or row.get("amount"))
        fee = parse_amount(row.get("fee_kobo") or row.get("fee") or 0)
        net = parse_amount(row.get("net_kobo") or row.get("net")) if (row.get("net_kobo") or row.get("net")) else max(0, gross - fee)
        sd = parse_date(row.get("settled_date") or row.get("settlement_date") or row.get("date"))
        db.add(Settlement(processor_ref=ref, order_ref=(row.get("order_id") or row.get("order_ref") or "").strip() or None, batch_id=(row.get("batch_id") or ref).strip(), gross_kobo=gross, fee_kobo=fee, net_kobo=net, settled_date=(sd.date() if sd else date.today()))); added += 1
    db.commit(); print(f"settlements: added={added} skipped_existing={skipped}")
with open("data/demo_bank_transactions.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("bank columns:", r.fieldnames)
    added = skipped = 0
    for row in r:
        ref = (row.get("bank_ref") or row.get("reference") or row.get("transaction_ref") or "").strip()
        if not ref: continue
        if db.query(BankTransaction).filter(BankTransaction.bank_ref == ref).first(): skipped += 1; continue
        amt = parse_amount(row.get("amount_kobo") or row.get("amount"))
        vd = parse_date(row.get("value_date") or row.get("date") or row.get("transaction_date"))
        db.add(BankTransaction(bank_ref=ref, narration=(row.get("narration") or row.get("description") or ref).strip()[:255], amount_kobo=amt, value_date=(vd.date() if vd else date.today()))); added += 1
    db.commit(); print(f"bank: added={added} skipped_existing={skipped}")
print("--- TOTALS IN DB ---")
print("orders:", db.query(Order).count())
print("settlements:", db.query(Settlement).count())
print("bank:", db.query(BankTransaction).count())
db.close()
