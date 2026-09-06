import { VOICES, VOICES_DISCLAIMER } from "@/lib/voices";
import { VoiceImage } from "@/components/VoiceImage";
import { OCTAGON } from "@/components/Brand";

/* Notable Voices — a premium editorial discovery module. Recommended
 * listening/viewing from recognisable people around MMA; framed strictly as
 * editorial recommendations with the non-affiliation note printed in the
 * module itself. Outbound links are rel="noopener nofollow". */
export function Voices() {
  return (
    <section className="sec voices-sec" aria-labelledby="voices-title">
      <div className="wrap">
        <div className="sec-head voices-head">
          <div>
            <div className="eyebrow">Notable voices</div>
            <h2 id="voices-title">From Inside the Fight Game</h2>
            <p className="voices-lede">Conversations, analysis and perspective from some of the most recognizable voices around mixed martial arts.</p>
          </div>
        </div>
        <div className="voices">
          {VOICES.map((v) => (
            <article className="voice" key={v.key}>
              <svg className="voice-cage" viewBox="0 0 64 64" aria-hidden="true"><polygon points={OCTAGON} fill="none" stroke="#d4af37" strokeWidth="1" strokeLinejoin="round" /></svg>
              <div className="voice-media">
                <VoiceImage src={v.image?.src || null} width={v.image?.width} height={v.image?.height} focal={v.image?.focal} alt={v.image?.alt || v.name} name={v.name} label={v.label} />
              </div>
              <div className="voice-body">
                <span className="voice-label">{v.label}</span>
                <h3>{v.name}</h3>
                <p>{v.descriptor}</p>
                <a className="voice-cta" href={v.href} target="_blank" rel="noopener nofollow" aria-label={`${v.cta} — opens ${v.destination} in a new tab`}>
                  <span>{v.cta}</span>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11m0 0-4.5-4.5M15 10l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </a>
                {v.image && (v.image.author || v.image.license) && (
                  <div className="voice-credit">
                    Photo: <a href={v.image.source_url} rel="noopener nofollow" target="_blank">{v.image.author}</a>
                    {" · "}{v.image.license_url ? <a href={v.image.license_url} rel="noopener nofollow" target="_blank">{v.image.license}</a> : v.image.license}
                    {" · via Wikimedia Commons"}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
        <p className="voices-note">{VOICES_DISCLAIMER}</p>
      </div>
    </section>
  );
}
