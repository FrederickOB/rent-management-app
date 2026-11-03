/** Who to ask about a pay or receipt link: the landlord or agency, with their phone and email. */
export function LandlordContact({
  landlord,
}: {
  landlord: { readonly name: string; readonly phone: string | null; readonly email: string | null };
}) {
  return (
    <section className="panel contact" aria-labelledby="contact">
      <h2 id="contact">Questions?</h2>
      <p>Contact {landlord.name}.</p>
      {landlord.phone ? (
        <p>
          Phone: <a href={`tel:${landlord.phone}`}>{landlord.phone}</a>
        </p>
      ) : null}
      {landlord.email ? (
        <p>
          Email: <a href={`mailto:${landlord.email}`}>{landlord.email}</a>
        </p>
      ) : null}
    </section>
  );
}
