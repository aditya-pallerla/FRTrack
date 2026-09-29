/**
 * Deterministic keyword extractor for flood reports (English, Hindi, Marathi — script and romanised).
 * Used for replay scenario reports (so the replay is reproducible) and as the fallback when Gemini is
 * unavailable. It only extracts evidence; it never decides a warning level.
 */
import type { FloodReportKind, ReportEvidence } from '../../../shared/types.js';

const PATTERNS: [FloodReportKind, RegExp][] = [
  ['water_in_homes', /water (has )?(entered|in|inside|into) (the )?(house|home)s?|flooded (house|home)s?|घर(ों)? में पानी|पानी घर|घरात पाणी|पाणी घरात|ghar(a|at)? (me|mein|madhe)? ?pa(a)?n(i|ee)/i],
  ['road_flooded', /road (is )?(flooded|under water|submerged|closed|blocked)|water on (the )?road|सड़क (पर पानी|बंद|डूब)|रस्ता (बंद|पाण्याखाली)|रस्त्यावर पाणी|rasta band|raste par paani/i],
  ['bridge_submerged', /bridge (is )?(submerged|under water|flooded|closed)|पुल (डूब|बंद)|पूल (पाण्याखाली|बंद)|पुलावर पाणी|pool (band|paanyakhali)/i],
  ['people_trapped', /trapped|stranded|stuck on (the )?roof|फंसे|फँसे|अडकल|अडकले|अडकून|phase hue|adakle/i],
  ['rescue_needed', /need (a )?(rescue|boat|help urgently)|send (a )?boat|rescue (us|them|needed)|बचाओ|बचाव|नाव भेज|मदत (हवी|करा)|बोट पाठवा|bachao|madat/i],
  ['water_rising', /water (level )?(is )?(rising|increasing|going up)|river (is )?(rising|overflowing)|पानी बढ़|पाणी (वाढत|वाढले)|नदी(ला)? पूर|paani badh|paani vadhat/i],
  ['vehicles_cannot_pass', /(cars?|vehicles?|bus(es)?|trucks?) (can(no|')t|cannot|unable to) (pass|go|cross)|traffic stopped|वाहन(ें)? नहीं|वाहतूक (बंद|ठप)|गाड्या जाऊ शकत नाही/i],
  ['shelter_inaccessible', /(shelter|relief camp|school) (is )?(flooded|cut off|unreachable|inaccessible)|निवारा (केंद्र )?(बंद|पाण्याखाली)/i],
  ['road_open', /road (is )?(open|clear|passable)|water (has )?(receded|gone down)|रस्ता (सुरू|मोकळा)|पाणी ओसरल|सड़क खुली|rasta chalu/i],
  ['no_flooding', /no (flood|flooding|water)|not flooded|पानी नहीं है|पूर नाही/i],
];

const NUM = /(\d{1,4})\s*(people|persons|log|लोग|लोक|जण|व्यक्ती)/i;
const INJURED = /injur|hurt|घायल|जखमी|zakhmi|ghayal/i;
const VULNERABLE = /child|children|kids|elderly|old (man|woman|people)|pregnant|disabled|बच्चे|बुजुर्ग|बुज़ुर्ग|मुले|लहान मुले|वृद्ध|आजी|आजोबा|गर्भवती|अपंग/i;

export function detectLanguage(text: string): ReportEvidence['language'] {
  const deva = /[ऀ-ॿ]/.test(text);
  const latin = /[a-z]{3,}/i.test(text);
  if (deva && latin) return 'mixed';
  if (deva) return /(आहे|पाणी|घरात|नाही|रस्ता|अडकले)/.test(text) ? 'mr' : 'hi';
  return latin ? 'en' : 'unknown';
}

export function keywordExtract(text: string): ReportEvidence {
  const kinds = PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  // "Road open" wording inside a report that also says the road is flooded is not a contradiction.
  const flooding = kinds.some((k) => k !== 'road_open' && k !== 'no_flooding');
  const finalKinds = flooding ? kinds.filter((k) => k !== 'road_open' && k !== 'no_flooding') : kinds;
  const count = text.match(NUM);
  const trapped = finalKinds.includes('people_trapped') ? (count ? Number(count[1]) : -1) : 0;
  return {
    kinds: finalKinds,
    road_blocked: finalKinds.includes('road_flooded') || finalKinds.includes('bridge_submerged') || finalKinds.includes('vehicles_cannot_pass'),
    people_trapped: trapped,
    injured: INJURED.test(text) ? -1 : 0,
    vulnerable_present: VULNERABLE.test(text),
    place_text: null,
    language: detectLanguage(text),
    extractor: 'keyword',
    extractor_confidence_hint: null,
  };
}
