/**
 * Turning ratings into search terms (design sections 19 and 20).
 *
 * No model is involved. Design section 19 asks for exploration terms derived from what
 * is currently rated highly, and the tags a video already carries are exactly that,
 * written by the uploader rather than inferred by us. Terms are counted, not embedded,
 * which is what keeps this in the Worker instead of on a GPU.
 *
 * Two scripts, not one. Splitting on whitespace turns a Japanese title into a single
 * token — the whole title — and searching for that returns nothing while still costing
 * one of a hundred daily search calls. `Intl.Segmenter` is in the Workers runtime and
 * segments Japanese properly, so it is used for both scripts rather than keeping a
 * whitespace path for Latin text that would then behave differently.
 */

/** Hiragana, katakana, or CJK ideographs. */
const JAPANESE = /[぀-ゟ゠-ヿ㐀-䶿一-鿿]/

export type Script = 'ja' | 'latin'

export function scriptOf(text: string): Script {
  return JAPANESE.test(text) ? 'ja' : 'latin'
}

/**
 * Words that appear in every title and identify nothing. Searching for one spends a
 * call from an allowance of a hundred on a term that matches everything.
 *
 * The two lists are the same list in two languages: articles and connectives, then the
 * words that describe the *format* of a video rather than its subject.
 */
const STOP_WORDS = new Set([
  // Latin: articles, connectives, and format words.
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'how', 'why', 'you', 'your',
  'video', 'part', 'full', 'new', 'best', 'top', 'watch', 'live', 'official', 'episode',
  'tutorial', 'guide', 'review', 'vs', 'ep', 'feat', 'ft', 'hd', '4k',

  // Japanese particles, auxiliaries and pronouns. `Intl.Segmenter` returns these as
  // word-like segments, so without this list every title would contribute 「の」.
  'の', 'は', 'を', 'に', 'が', 'で', 'と', 'も', 'や', 'へ', 'から', 'まで', 'より',
  'ば', 'ね', 'よ', 'な', 'か', 'て', 'た', 'だ', 'です', 'ます', 'ました', 'する',
  'した', 'して', 'される', 'いる', 'ある', 'なる', 'こと', 'もの', 'ため', 'よう',
  'これ', 'それ', 'あれ', 'この', 'その', 'あの', 'とき', 'とは', 'について',
  // Quotative and connective particles that `Intl.Segmenter` returns as word-like.
  // 「って」 reached a live search before this list caught it, spending one of a
  // hundred daily calls on a term that matches everything.
  'って', 'では', 'にて', 'から', 'ので', 'のに', 'ため', 'ながら', 'たり', 'つつ',
  'そして', 'しかし', 'また', 'でも', 'ただ', 'もう', 'まだ', 'すぐ', 'よく',

  // Japanese format words, the counterparts of "tutorial" and "review" above.
  '動画', '解説', '紹介', '講座', '入門', '初心者', '実況', '公開', '最新', '完全',
  '徹底', 'まとめ', '第', '話', '回', '前編', '後編',
])

export interface RatedText {
  title: string
  tags: string[]
  channelTitle: string | null
  /** 0..5, used to weight how much this video's terms count. */
  rating: number
}

/**
 * Terms worth searching for, most characteristic first.
 *
 * A term's weight is the sum of the ratings of the videos it appears in, so one video
 * rated five contributes more than two rated one. Tags count double: a tag is a claim
 * about the subject, while a title word may just be phrasing.
 */
export function interestTerms(rated: RatedText[], limit: number): string[] {
  const weights = new Map<string, number>()

  const add = (term: string, weight: number) => {
    const normalised = normalise(term)
    if (!normalised) return
    weights.set(normalised, (weights.get(normalised) ?? 0) + weight)
  }

  for (const item of rated) {
    // Only what the user actually wants more of. A video rated 2 says "less of this",
    // and searching for its terms would be reading the sign backwards.
    if (item.rating < 3) continue
    const weight = item.rating - 2

    // Tags are taken whole. A tag is already the phrase the uploader chose; segmenting
    // it would break 「ブラウザエンジン」 back into two weaker terms.
    for (const tag of item.tags.slice(0, 10)) add(tag, weight * 2)
    for (const word of splitTitle(item.title)) add(word, weight)
  }

  return [...weights.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term)
}

/**
 * A term reduced to the form it is counted under, or null when it is not worth counting.
 *
 * Length is judged per script: three characters of Latin is barely a word, while two
 * characters of Japanese is most of them — 「関数」, 「配列」, 「型」. One rule for both
 * would either flood the list with Latin fragments or discard most Japanese nouns.
 */
function normalise(term: string): string | null {
  const trimmed = term.trim().toLowerCase()
  if (!trimmed) return null
  if (STOP_WORDS.has(trimmed)) return null
  if (/^\d+$/.test(trimmed)) return null

  const minimum = scriptOf(trimmed) === 'ja' ? 2 : 3
  if (trimmed.length < minimum || trimmed.length > 40) return null
  return trimmed
}

/**
 * Title words, plus adjacent pairs.
 *
 * Pairs matter more than single words: 「ブラウザ」 is a category and 「ブラウザエンジン」
 * is a subject, and the two return very different search results. Japanese pairs are
 * joined without a space, because that is how the compound is actually written and a
 * space would make it a two-term query for something that is one thing.
 */
export function splitTitle(title: string): string[] {
  const cleaned = title.replace(/[\[\(\{【（].*?[\]\)\}】）]/g, ' ')

  const segmenter = new Intl.Segmenter(scriptOf(cleaned) === 'ja' ? 'ja' : 'en', {
    granularity: 'word',
  })

  const words: string[] = []
  for (const segment of segmenter.segment(cleaned)) {
    if (!segment.isWordLike) continue
    const word = segment.segment.trim()
    // Filtered here as well as in `normalise`, so that a particle cannot become half of
    // a bigram: 「カーネル」+「の」 is not a subject.
    if (!word || STOP_WORDS.has(word.toLowerCase())) continue
    words.push(word)
  }

  const terms = [...words]
  for (let index = 0; index + 1 < words.length; index += 1) {
    const left = words[index] as string
    const right = words[index + 1] as string
    const joiner = scriptOf(left) === 'ja' && scriptOf(right) === 'ja' ? '' : ' '
    terms.push(`${left}${joiner}${right}`)
  }
  return terms
}

/**
 * Adjacent topics for the explore lane (design section 20).
 *
 * The design's own example is a chain: browser engine to operating system to computer
 * architecture to CPU history. Each step stays in the same intellectual neighbourhood
 * while leaving the exact subject the user already has, which is the thing a similarity
 * search cannot do — nearest-neighbour returns more of the same by definition.
 *
 * Each entry carries the neighbour in both languages, and the one that goes out matches
 * the script of the seed. That is not politeness: the neighbour *is* the search query,
 * so an English query on behalf of someone who watches Japanese content returns videos
 * they will not want, and the lane quietly stops being useful to them.
 *
 * A static table, as design section 20 permits for V1. It is small, wrong in ways that
 * are visible, and cheap to correct, which is more than can be said for an embedding
 * walk that would need a GPU in the discovery path.
 */
interface Adjacency {
  match: RegExp
  en: string[]
  ja: string[]
}

const ADJACENCY: Adjacency[] = [
  {
    match: /browser|firefox|chromium|webkit|gecko|ブラウザ|ファイアフォックス/i,
    en: ['operating system internals', 'rendering engine', 'web standards history'],
    ja: ['OS 内部構造', 'レンダリングエンジン', 'Web標準 歴史'],
  },
  {
    match: /linux|kernel|unix|bsd|カーネル|リナックス|ユニックス/i,
    en: ['computer architecture', 'operating system design', 'systems programming'],
    ja: ['コンピュータアーキテクチャ', 'オペレーティングシステム 設計', 'システムプログラミング'],
  },
  {
    match: /compiler|llvm|rust|typescript|language|コンパイラ|プログラミング言語|型システム/i,
    en: ['programming language theory', 'type systems', 'compiler design'],
    ja: ['プログラミング言語 理論', '型システム', 'コンパイラ 設計'],
  },
  {
    match: /cpu|gpu|hardware|silicon|arm|risc|プロセッサ|半導体|ハードウェア/i,
    en: ['computing history', 'semiconductor manufacturing', 'computer architecture'],
    ja: ['コンピュータ 歴史', '半導体 製造', 'コンピュータアーキテクチャ'],
  },
  {
    match: /network|tcp|http|dns|protocol|ネットワーク|プロトコル|通信/i,
    en: ['distributed systems', 'internet history', 'network security'],
    ja: ['分散システム', 'インターネット 歴史', 'ネットワークセキュリティ'],
  },
  {
    match: /database|sql|sqlite|storage|データベース|ストレージ/i,
    en: ['distributed systems', 'file system design', 'data structures'],
    ja: ['分散システム', 'ファイルシステム 設計', 'データ構造'],
  },
  {
    match: /machine learning|neural|llm|ai agent|transformer|機械学習|ニューラル|生成AI/i,
    en: ['information retrieval', 'statistics', 'computational linguistics'],
    ja: ['情報検索', '統計学', '計算言語学'],
  },
  {
    match: /security|cryptography|exploit|vulnerability|セキュリティ|暗号|脆弱性/i,
    en: ['formal verification', 'protocol design', 'privacy engineering'],
    ja: ['形式検証', 'プロトコル 設計', 'プライバシー 技術'],
  },
  {
    match: /design|typography|interface|ux|デザイン|タイポグラフィ|インターフェース/i,
    en: ['human computer interaction', 'design history', 'accessibility'],
    ja: ['ヒューマンインターフェース', 'デザイン 歴史', 'アクセシビリティ'],
  },
  {
    match: /music|guitar|synth|audio|音楽|ギター|シンセ|オーディオ/i,
    en: ['acoustics', 'music theory', 'audio engineering'],
    ja: ['音響学', '音楽理論', 'オーディオ 技術'],
  },
  // Added after a live run: the seeds were `vtuber`, `バーチャルyoutuber` and a
  // production's name, none of which matched anything above, so the lane fell through
  // to the leftover technical seeds and offered someone who watches music videos a
  // search for operating system design. A table this small is wrong in exactly this
  // way until real ratings show where the gaps are.
  {
    match: /vtuber|バーチャルyoutuber|ホロライブ|にじさんじ|hololive|vsinger/i,
    en: ['virtual singer', 'motion capture performance', 'independent music label'],
    ja: ['バーチャルシンガー', 'ライブ演出', 'インディーズ音楽レーベル'],
  },
  {
    match: /歌ってみた|カバー曲|cover song|utaite|ボカロ|vocaloid|ボーカロイド/i,
    en: ['songwriting', 'vocal arrangement', 'music production'],
    ja: ['作詞作曲', 'ボーカルアレンジ', '音楽制作 舞台裏'],
  },
  {
    match: /アニメ|anime|op映像|劇伴|サウンドトラック|soundtrack/i,
    en: ['film scoring', 'animation production', 'sound design'],
    ja: ['劇伴 作曲', 'アニメーション 制作', 'サウンドデザイン'],
  },
]

/**
 * One step sideways from each seed term, in the script the seed was written in.
 *
 * `preferred` decides what to do when the seeds are all Latin but the user watches
 * Japanese content — a common case, because tags are often written in English on
 * Japanese channels.
 */
export function adjacentTopics(seeds: string[], limit: number, preferred: Script = 'latin'): string[] {
  const found = new Set<string>()

  for (const seed of seeds) {
    for (const entry of ADJACENCY) {
      if (!entry.match.test(seed)) continue

      const script = scriptOf(seed) === 'ja' ? 'ja' : preferred
      for (const neighbour of script === 'ja' ? entry.ja : entry.en) {
        if (found.size >= limit) return [...found]
        // A neighbour the user is already deep in is not a step sideways.
        if (seeds.some((other) => other.includes(neighbour) || neighbour.includes(other))) continue
        found.add(neighbour)
      }
    }
  }

  return [...found]
}
