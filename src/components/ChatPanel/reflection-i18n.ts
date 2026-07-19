// Reflection-detection keyword tables grouped by language. Edit per-language
// blocks here when adding/tuning markers; MarkdownView.tsx imports the three
// composed RegExps below. Avoids the 600-char inline regex maintenance burden
// (iter-40 follow-up — see dev-log iter-80).
//
// STRONG: high-specificity phrases that flag reflection alone.
// SOFT: lower-specificity markers; need corroboration to flag.
// STRONG_CORR: explicit correction verbs/nouns; fire within 40 chars of SOFT.
// (WEAK_CORR — `错|忘` — stays inline in MarkdownView; it's tiny and Chinese-only.)

const STRONG_PARTS: string[] = [
  // zh
  '让我重新(?!整理|规划|梳理|组织|排列|安排)', '让我换', '我错了', '做错了', '之前的?做法', '对不起', '抱歉',
  // en
  'let me (?:try|redo|re-do)', 'on second thought', 'reconsidering',
  // ja
  'ごめん(?:なさい)?', 'すみません', '申し訳', '訂正', 'やり直し',
  // ko
  '죄송', '미안합니다', '잘못 (?:말|했)',
  // es
  'lo siento', 'perdón', 'me equivoqué', 'déjame (?:corregir|reconsider)',
  // fr
  'désolé', 'je me corrige',
  // de
  'entschuldigung', 'ich korrigiere',
  // it
  'scusa', 'scusami', 'mi scuso', 'mi sbagli',
  // pt
  'desculpa', 'peço desculpa', 'me enganei',
  // ru
  'извини(?:те)?', 'прости', 'ошибся', 'ошиблась',
];

const SOFT_PARTS: string[] = [
  // zh / en
  '等等', '等下', '其实', '实际上', '刚才', '不对', 'sorry[,，:]', 'hmm,', 'wait,', 'actually,',
  // ja
  'あれ?,', '待って', '実は', '本当は',
  // ko
  '잠깐', '사실은',
  // es / fr / de
  'espera,', 'en realidad,', 'de hecho,', 'attends,', 'en fait,', 'en réalité,', 'warte,', 'eigentlich,',
  // it / pt / ru
  'aspetta,', 'in realtà,', 'in effetti,', 'na verdade,', 'aliás,', 'подожди,', 'на самом деле,', 'кстати,',
];

const STRONG_CORR_PARTS: string[] = [
  // zh / en
  '不对', '重新', '让我', '改正', '改写', 'wrong', 'mistake', 'fix', 'sorry', 'apolog', 'reconsider',
  // ja / ko
  '間違', 'やり直', '訂正', '申し訳', '잘못', '죄송',
  // es / fr / de
  'equivoq', 'corregir', 'erróneo', 'erreur', 'trompé', 'corriger', 'fehler', 'korrigier', 'vergess',
  // it / pt / ru
  'sbaglio', 'sbagli', 'errore', 'correggere', 'engan', 'errado', 'corrigir', 'ошиб', 'неправ', 'исправ',
];

export const STRONG_REFLECTION_RE = new RegExp('^(?:' + STRONG_PARTS.join('|') + ')', 'i');
export const SOFT_REFLECTION_RE = new RegExp('^(?:' + SOFT_PARTS.join('|') + ')', 'i');
export const STRONG_CORR_RE = new RegExp('(' + STRONG_CORR_PARTS.join('|') + ')', 'i');
