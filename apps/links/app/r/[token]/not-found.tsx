/** Shown for a receipt link that does not resolve: unknown, or no longer kept. */
export default function ReceiptLinkNotValid() {
  return (
    <>
      <h1>This link is not valid or has expired</h1>
      <p>
        Links stop working after a while. Your receipts are also in the tenant app, or ask your
        landlord or property manager for a copy.
      </p>
    </>
  );
}
