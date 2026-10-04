// The subset of the sanitize-html API this port uses (the package ships no types).
declare module 'sanitize-html' {
  type Attributes = Record<string, string>;
  interface Options {
    allowedTags?: string[];
    allowedAttributes?: Record<string, string[]>;
    allowedSchemes?: string[];
    allowedSchemesAppliedToAttributes?: string[];
    allowProtocolRelative?: boolean;
    transformTags?: Record<string, (tagName: string, attribs: Attributes) => { tagName: string; attribs: Attributes }>;
  }
  interface SanitizeHtml {
    (html: string, options?: Options): string;
    defaults: { allowedTags: string[] };
  }
  const sanitizeHtml: SanitizeHtml;
  export default sanitizeHtml;
}
