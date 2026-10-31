// Character references in HTML text, decoded the way the browser's tokenizer decodes them (WHATWG HTML §13.2.5.72
// to §13.2.5.80), with the same table as Bascik's own decoder (pkg/src/lib/character-references.ts). Kept here so
// the refactor scripts stay dependency-free; skills-tests/tests/refactor-decode-entities.test.ts holds this copy to
// Bascik's decoder.
//
// Decoded: numeric references, decimal or hex, with or without the semicolon (0x80-0x9F remapped as windows-1252;
// 0, a surrogate or anything past U+10FFFF become U+FFFD), and a named reference written with its semicolon whose
// exact spelling is in the table (names are case-sensitive: &Eacute; is É, &Amp; is no reference): the ASCII
// names and HTML 4's 252. Left as written: a name without its semicolon (&amp), any other name (HTML5's &Lt;),
// and an & that starts no reference. One pass: a decoded & never starts another reference.

/** The named references whose character is ASCII, each with its code point in hex. */
const ASCII_NAMES =
  "Tab 9,NewLine a,excl 21,quot 22,QUOT 22,num 23,dollar 24,percnt 25,amp 26,AMP 26,apos 27,lpar 28,rpar 29," +
  "ast 2a,midast 2a,plus 2b,comma 2c,period 2e,sol 2f,colon 3a,semi 3b,lt 3c,LT 3c,equals 3d,gt 3e,GT 3e," +
  "quest 3f,commat 40,lsqb 5b,lbrack 5b,bsol 5c,rsqb 5d,rbrack 5d,Hat 5e,lowbar 5f,UnderBar 5f,grave 60," +
  "DiacriticalGrave 60,lcub 7b,lbrace 7b,verbar 7c,vert 7c,VerticalLine 7c,rcub 7d,rbrace 7d";

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
const C1_REMAP = {
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

let table;

/** Every decoded name and its character, built on first use. */
const named = () => {
  if (table) return table;
  table = new Map([["fjlig", "fj"]]);
  for (const entry of `${ASCII_NAMES},${OTHER_NAMES}`.split(",")) {
    const [name, hex] = entry.split(" ");
    table.set(name, String.fromCodePoint(Number.parseInt(hex, 16)));
  }
  LATIN1_NAMES.split(" ").forEach((name, index) =>
    table.set(name, String.fromCodePoint(0xa0 + index)),
  );
  return table;
};

const numeric = (code) => {
  if (code === 0 || !(code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff))
    return "\ufffd";
  return String.fromCodePoint(C1_REMAP[code] ?? code);
};

/** `text` with its character references decoded (see the comment at the top for which). */
export function decodeCharacterReferences(text) {
  const value = String(text);
  if (!value.includes("&")) return value;
  return value.replace(
    /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g,
    (match, hex, dec, name) => {
      if (name !== undefined) return named().get(name) ?? match;
      return numeric(
        hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10),
      );
    },
  );
}
