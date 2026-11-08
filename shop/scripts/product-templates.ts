const sweatshirtVariants = {
  "Black / S": 20771,
  "Black / M": 20772,
  "Black / L": 20773,
  "Black / XL": 20774,
  "Black / 2XL": 20775,
  "Desert Dust / S": 20776,
  "Desert Dust / M": 20777,
  "Desert Dust / L": 20778,
  "Desert Dust / XL": 20779,
  "Desert Dust / 2XL": 20780,
};
export const productTemplates: Record<
  string,
  {
    id: number;
    title?: string;
    catalogVariantId?: number;
    draftTechnique?: string;
    catalogVariantIds?: Record<string, number>;
  }
> = {
  "100-organic-cotton-bascik-logo-front-unisex": { id: 109921208 },
  "100-organic-cotton-bascik-insignia-shirt-unisex": { id: 109921207 },
  "100-organic-cotton-bascik-logo-dad-hat-unisex": { id: 109921204 },
  "100-organic-cotton-bascik-insignia-dad-hat-unisex": { id: 109921206 },
  "organic-cotton-bascik-logo-sweatshirt-unisex": {
    id: 109989489,
    catalogVariantIds: sweatshirtVariants,
  },
  "organic-cotton-bascik-insignia-sweatshirt-unisex": {
    id: 109989447,
    catalogVariantIds: sweatshirtVariants,
  },
  "bascik-logo-vinyl-decal": {
    id: 109978527,
    title: "Kiss-cut vinyl decals",
    catalogVariantId: 24972,
    draftTechnique: "sticker",
  },
  "bascik-insignia-vinyl-decal": {
    id: 109978655,
    title: "Kiss-cut vinyl decals",
    catalogVariantId: 24971,
    draftTechnique: "sticker",
  },
};
