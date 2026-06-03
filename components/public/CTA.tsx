type CTAProps = { primary: string; secondary: string; primaryHref?: string; secondaryHref?: string };
export function CTA({ primary, secondary, primaryHref = "#offer", secondaryHref = "#details" }: CTAProps) {
  return <div className="actions"><a className="button primary" href={primaryHref}>{primary}</a><a className="button secondary" href={secondaryHref}>{secondary}</a></div>;
}
