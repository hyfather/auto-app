type CTAProps = { primary: string; secondary: string };
export function CTA({ primary, secondary }: CTAProps) {
  return <div className="actions"><a className="button primary" href="#offer">{primary}</a><a className="button secondary" href="#details">{secondary}</a></div>;
}
