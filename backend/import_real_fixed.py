import csv
from datetime import datetime, date
from app.core.database import SessionLocal
from app.models.tables import Order, Settlement, BankTransaction, Match, ReconException
db = SessionLocal()
# Wipe half-imported rows from failed run
db.query(Match).delete(); db.query(ReconException).delete()
db.query(Order).delete(); db.query(Settlement).delete(); db.query(BankTransaction).delete()
db.commit()
print("wiped old rows")

def pd(s):
    s=(s or "").strip()
    if not s: return None
    for fmt in ("%Y-%m-%d","%Y-%m-%d %H:%M:%S","%d/%m/%Y"):
        try: return datetime.strptime(s, fmt)
        except: pass
    return datetime.fromisoformat(s)

# ORDERS: order_ref = payment_reference (PAY-xxxx) - this is the link key
with open("data/demo_orders.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("orders columns:", r.fieldnames)
    for row in r:
        pay = row["payment_reference"].strip()
        db.add(Order(order_ref=pay, customer_name=f"{row['customer'].strip()} ({row['order_id'].strip()})", amount_kobo=int(float(row["amount_kobo"])), ordered_at=pd(row["order_date"])))
    db.commit(); print("orders:", db.query(Order).count())

# SETTLEMENTS: processor_ref = settlement_id (unique), order_ref = payment_reference (link)
with open("data/demo_settlements.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("settlements columns:", r.fieldnames)
    for row in r:
        db.add(Settlement(processor_ref=row["settlement_id"].strip(), order_ref=row["payment_reference"].strip(), batch_id=row["settlement_id"].strip(), gross_kobo=int(float(row["gross_kobo"])), fee_kobo=int(float(row["fee_kobo"])), net_kobo=int(float(row["net_kobo"])), settled_date=pd(row["settlement_date"]).date()))
    db.commit(); print("settlements:", db.query(Settlement).count())

# BANK: bank_ref = bank_transaction_id, amount = credit_kobo, narration = description
with open("data/demo_bank_transactions.csv", newline="", encoding="utf-8-sig") as f:
    r = csv.DictReader(f); print("bank columns:", r.fieldnames)
    for row in r:
        amt = int(float(row["credit_kobo"] or 0))
        if amt <= 0: continue
        db.add(BankTransaction(bank_ref=row["bank_transaction_id"].strip(), narration=f"{row['description'].strip()} | ref:{row['reference'].strip()}", amount_kobo=amt, value_date=pd(row["transaction_date"]).date()))
    db.commit(); print("bank:", db.query(BankTransaction).count())
db.close()
print("IMPORT OK")
