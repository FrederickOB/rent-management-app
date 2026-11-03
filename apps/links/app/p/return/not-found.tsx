/** A card return address that names no payment we know. */
export default function CardReturnNotFound() {
  return (
    <>
      <h1>We could not find this payment</h1>
      <p>
        This page opens when you come back from paying by card. If you paid, your receipt reaches
        you by SMS or email once the payment is confirmed. Otherwise, open the pay link in the
        message we sent you.
      </p>
    </>
  );
}
