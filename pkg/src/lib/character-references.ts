/**
 * @module character-references
 *
 * Character references in an attribute value as written, decoded the way the
 * browser decodes them (WHATWG HTML §13.2.5.72), for a value Bascik moves
 * somewhere else and escapes again: a prop. Decoding first and escaping once
 * where the value lands keeps `&mdash;` an em dash instead of the text
 * `&amp;mdash;`.
 *
 * Numeric references are decoded in full, with or without the semicolon,
 * including the C1 remapping (`&#150;` is an en dash). Named references are
 * decoded when they end in `;` and are one of: the ASCII ones
 * (`ASCII_NAMED_REFERENCES`, which also spell `&apos;`, `&colon;` and the
 * like), and the 252 of HTML 4 (Latin-1, Greek, math and arrows,
 * typographic punctuation such as `&nbsp;`, `&eacute;`, `&copy;`, `&mdash;`,
 * `&hellip;`, `&rsquo;`, `&euro;`, `&trade;`). Any other name, and a name
 * without its semicolon, stays as written, so it reaches the page as text.
 * The table is checked against parse5's tokenizer in the tests.
 *
 * Portable: no `node:*` imports (component-expansion-core.ts uses it).
 */
import { ASCII_NAMED_REFERENCES } from "./url-safety.ts";

/** HTML 4's Latin-1 names, for U+00A0 to U+00FF in order. */
const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not " + // codespell:ignore curren
  "shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 " +
  "ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml " +
  "Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute " +
  "Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring " +
  "aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth " +
  "ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute " +
  "ucirc uuml yacute thorn yuml";

/** HTML 4's other names, each with its code point in hex. */
const OTHER_NAMES =
  "fnof 192,Alpha 391,Beta 392,Gamma 393,Delta 394,Epsilon 395,Zeta 396," +
  "Eta 397,Theta 398,Iota 399,Kappa 39a,Lambda 39b,Mu 39c,Nu 39d,Xi 39e," +
  "Omicron 39f,Pi 3a0,Rho 3a1,Sigma 3a3,Tau 3a4,Upsilon 3a5,Phi 3a6," +
  "Chi 3a7,Psi 3a8,Omega 3a9,alpha 3b1,beta 3b2,gamma 3b3,delta 3b4," +
  "epsilon 3b5,zeta 3b6,eta 3b7,theta 3b8,iota 3b9,kappa 3ba,lambda 3bb," +
  "mu 3bc,nu 3bd,xi 3be,omicron 3bf,pi 3c0,rho 3c1,sigmaf 3c2,sigma 3c3," +
  "tau 3c4,upsilon 3c5,phi 3c6,chi 3c7,psi 3c8,omega 3c9,thetasym 3d1," +
  "upsih 3d2,piv 3d6,bull 2022,hellip 2026,prime 2032,Prime 2033," +
  "oline 203e,frasl 2044,weierp 2118,image 2111,real 211c,trade 2122," +
  "alefsym 2135,larr 2190,uarr 2191,rarr 2192,darr 2193,harr 2194," +
  "crarr 21b5,lArr 21d0,uArr 21d1,rArr 21d2,dArr 21d3,hArr 21d4," +
  "forall 2200,part 2202,exist 2203,empty 2205,nabla 2207,isin 2208," +
  "notin 2209,ni 220b,prod 220f,sum 2211,minus 2212,lowast 2217," + // codespell:ignore notin
  "radic 221a,prop 221d,infin 221e,ang 2220,and 2227,or 2228,cap 2229," +
  "cup 222a,int 222b,there4 2234,sim 223c,cong 2245,asymp 2248,ne 2260," +
  "equiv 2261,le 2264,ge 2265,sub 2282,sup 2283,nsub 2284,sube 2286," +
  "supe 2287,oplus 2295,otimes 2297,perp 22a5,sdot 22c5,lceil 2308," +
  "rceil 2309,lfloor 230a,rfloor 230b,lang 27e8,rang 27e9,loz 25ca," +
  "spades 2660,clubs 2663,hearts 2665,diams 2666,OElig 152,oelig 153," +
  "Scaron 160,scaron 161,Yuml 178,circ 2c6,tilde 2dc,ensp 2002,emsp 2003," +
  "thinsp 2009,zwnj 200c,zwj 200d,lrm 200e,rlm 200f,ndash 2013,mdash 2014," +
  "lsquo 2018,rsquo 2019,sbquo 201a,ldquo 201c,rdquo 201d,bdquo 201e," +
  "dagger 2020,Dagger 2021,permil 2030,lsaquo 2039,rsaquo 203a,euro 20ac";

/** What a numeric reference in 0x80-0x9F stands for (windows-1252). */
const C1_REMAP: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x2c6,
  0x89: 0x2030,
  0x8a: 0x160,
  0x8b: 0x2039,
  0x8c: 0x152,
  0x8e: 0x17d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x2dc,
  0x99: 0x2122,
  0x9a: 0x161,
  0x9b: 0x203a,
  0x9c: 0x153,
  0x9e: 0x17e,
  0x9f: 0x178,
};

let namedReferences: Map<string, string> | undefined;

/** Every decoded name and its character, built on first use. */
const named = (): Map<string, string> => {
  if (namedReferences) return namedReferences;
  const table = new Map<string, string>(Object.entries(ASCII_NAMED_REFERENCES));
  LATIN1_NAMES.split(" ").forEach((name, index) =>
    table.set(name, String.fromCodePoint(0xa0 + index)),
  );
  for (const entry of OTHER_NAMES.split(",")) {
    const [name, hex] = entry.split(" ");
    table.set(name, String.fromCodePoint(Number.parseInt(hex, 16)));
  }
  namedReferences = table;
  return table;
};

/** The decoded names and their characters (read-only; for the tests). */
export const namedCharacterReferences = (): ReadonlyMap<string, string> =>
  named();

/** The character a numeric reference stands for, as the tokenizer maps it. */
const numericCharacter = (code: number): string => {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
    return "�";
  return String.fromCodePoint(C1_REMAP[code] ?? code);
};

/**
 * `value` with its character references decoded (see the module comment for
 * which). One pass, so `&amp;mdash;` becomes the text `&mdash;`, never a
 * dash. A value without `&` is returned as it is.
 */
export const decodeCharacterReferences = (value: string): string =>
  value.includes("&")
    ? value.replace(
        /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
        (match, hex?: string, dec?: string, name?: string) => {
          if (name !== undefined) return named().get(name) ?? match;
          const code =
            hex !== undefined
              ? Number.parseInt(hex, 16)
              : Number.parseInt(dec!, 10);
          return numericCharacter(code);
        },
      )
    : value;
