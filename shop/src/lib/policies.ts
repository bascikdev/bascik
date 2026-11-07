import { escapeHtml } from "./catalog.ts";
import { freeShippingOffer, freeShippingDetails } from "./free-shipping.ts";

export const supportEmail = "shop@bascik.dev";
const contact = `<a href="mailto:${supportEmail}">${supportEmail}</a>`;
const paragraph = (text: string) => `<p>${text}</p>`;
const section = (title: string, ...text: string[]) =>
  `<h2>${escapeHtml(title)}</h2>${text.map(paragraph).join("")}`;

// Owner-published policies from shop.bascik.dev, with platform-specific disclosures updated.
export const refundPolicy =
  section(
    "Final Sale Policy",
    "All sales are final. We do not accept returns, refunds, or exchanges for buyer's remorse, incorrect size selection, or change of mind once an order has been placed.",
  ) +
  section(
    "Damages and Issues",
    `Please inspect your order immediately upon reception. If an item arrives defective, damaged, or if you received the wrong item, contact us within 7 days of delivery at ${contact} so we can evaluate the issue and arrange a replacement or refund.`,
  ) +
  section(
    "European Union & United Kingdom Customers",
    "Notwithstanding the above policy, if merchandise is being shipped to a consumer in the European Union or the United Kingdom, you have the right under local consumer law to cancel or return your order within 14 days of receipt, for any reason and without justification.",
    "To be eligible for a return under the 14-day cooling-off period, the item must be unworn, unused, in its original condition, and in its original packaging. You will also need the receipt or proof of purchase. Return shipping costs for EU/UK cooling-off returns are the responsibility of the customer.",
    `To initiate an EU/UK return or report a damaged item, contact us at ${contact}. Items sent back to us without prior authorization will not be accepted. Approved returns must be shipped to the physical address provided in the return approval confirmation email you receive.`,
  ) +
  section(
    "Refunds",
    "Once we receive and inspect your authorized return, we will notify you of the status. If approved, the refund will be processed back to your original payment method within 10 business days. Please note that banks or credit card companies may require additional time to post the credit to your account.",
  );

export const termsPolicy =
  section(
    "1. Overview",
    'Bascik Shop ("we", "us", "our") operates this online store and related services. By visiting our site or purchasing from us, you agree to be bound by these Terms of Service and our <a href="/privacy">Privacy Policy</a>. Our store is built with Bascik and hosted on Cloudflare, with payments processed by Stripe and orders fulfilled by Printful.',
  ) +
  section(
    "2. Products and Orders",
    "<strong>Products:</strong> Colors and images are displayed as accurately as possible, but screen displays vary. We reserve the right to limit quantities or discontinue products at any time without notice.",
    "<strong>Orders:</strong> Placing an order constitutes an offer to purchase. We reserve the right to accept, decline, or cancel any order for any reason (including pricing errors or stock availability). You represent that all purchases are for personal use only and not for commercial resale.",
    '<strong>Returns:</strong> Purchases are subject strictly to our published <a href="/policies/refund-policy">Refund Policy</a>.',
  ) +
  section(
    "3. Pricing and Billing",
    "Prices are subject to change without notice. Posted prices do not include taxes, shipping, or import duties unless explicitly stated. You must provide accurate billing and payment information and represent that you are authorized to use the payment method provided.",
  ) +
  section(
    "4. Shipping and Delivery",
    `${freeShippingOffer} ${freeShippingDetails}`,
    "All delivery estimates are non-binding. Risk of loss and title for items pass to you upon delivery of the items to the shipping carrier. We are not liable for shipping delays outside our reasonable control.",
  ) +
  section(
    "5. Intellectual Property",
    "All logos, designs, artwork, product graphics, images, and text on this site are the property of Bascik Shop or its licensors. You may not reproduce, distribute, or modify any content without our express written permission.",
  ) +
  section(
    "6. Prohibited Uses",
    "You may not use our site or products for any unlawful purpose, to infringe upon intellectual property, to transmit malicious code, or to collect user data without authorization. We reserve the right to terminate access for violations.",
  ) +
  section(
    "7. Limitation of Liability & Warranty Disclaimer",
    'The site and all products are provided <strong>"AS IS"</strong> and <strong>"AS AVAILABLE"</strong> without warranties of any kind, express or implied. To the fullest extent permitted by law, Bascik Shop and its affiliates, directors, or providers (including Cloudflare, Stripe, and Printful) shall not be liable for any indirect, incidental, punitive, or consequential damages, or any loss of profits or data arising from your use of the site or products.',
  ) +
  section(
    "8. Indemnification",
    "You agree to indemnify and hold harmless Bascik Shop and its service providers from any claims, liabilities, or expenses (including legal fees) arising from your breach of these Terms or violation of any law or third-party rights.",
  ) +
  section(
    "9. Governing Law",
    "These Terms of Service are governed by and construed in accordance with the laws of the jurisdiction where Bascik Shop operates, without regard to conflict of law principles.",
  ) +
  section(
    "10. Changes to Terms",
    "We reserve the right to update these Terms at any time by posting changes to this page. Continued use of the site following changes constitutes acceptance.",
  ) +
  section(
    "11. Contact Information",
    `Questions regarding these Terms of Service should be directed to us at: ${contact}.`,
  );

export const privacyPolicy =
  paragraph("Last updated: November 6, 2026") +
  paragraph(
    'Bascik Shop operates this store and website, including all related information, content, features, tools, products and services, in order to provide you, the customer, with a curated shopping experience (the "Services"). Our store is built with Bascik and hosted on Cloudflare, with payments processed by Stripe and fulfillment provided by Printful. This Privacy Policy describes how we collect, use, and disclose your personal information when you visit, use, or make a purchase or other transaction using the Services or otherwise communicate with us. If there is a conflict between our Terms of Service and this Privacy Policy, this Privacy Policy controls with respect to the collection, processing, and disclosure of your personal information.',
  ) +
  paragraph(
    "Please read this Privacy Policy carefully. By using and accessing any of the Services, you acknowledge that you have read this Privacy Policy and understand the collection, use, and disclosure of your information as described in this Privacy Policy.",
  ) +
  section(
    "Personal Information We Collect or Process",
    'When we use the term "personal information," we are referring to information that identifies or can reasonably be linked to you or another person. Personal information does not include information that is collected anonymously or that has been de-identified, so that it cannot identify or be reasonably linked to you. Depending on how you interact with the Services, where you live, and as permitted or required by applicable law, we may collect or process:',
    "<strong>Contact details:</strong> your name, address, billing address, shipping address, phone number when provided to our service providers, and email address.",
    "<strong>Financial and transaction information:</strong> payment confirmation, transaction details, payment method, and items purchased, returned, exchanged or cancelled. Payment card and financial account details are processed by Stripe; the shop does not receive or store your full card number or security code.",
    "<strong>Preferences:</strong> your cart and color-theme choices stored in your browser. This storefront does not provide customer accounts, passwords, wishlists, or reviews.",
    "<strong>Communications with us:</strong> information included in customer support inquiries.",
    "<strong>Device and usage information:</strong> information about your device, browser, network connection, IP address, and interaction with the Services. Hosting and payment providers may process this information for service operation, security, and fraud prevention.",
  ) +
  section(
    "Personal Information Sources",
    "<strong>Directly from you:</strong> when you visit or use the Services, communicate with us, or provide delivery and contact details.",
    "<strong>Automatically through the Services:</strong> from your device and through browser storage, cookies, or similar technologies used by our service providers.",
    "<strong>From our service providers:</strong> when they process personal information on our behalf to operate the store, process payments, fulfill orders, or deliver notifications.",
  ) +
  section(
    "How We Use Your Personal Information",
    "<strong>Provide, Tailor, and Improve the Services:</strong> to perform our contract with you, process payments and orders, remember preferences and cart items, send order notifications, arrange shipping, and facilitate authorized returns and refunds.",
    "<strong>Security and Fraud Prevention:</strong> to provide a secure payment and shopping experience, detect, investigate or take action regarding fraudulent, illegal, unsafe, or malicious activity, protect public safety, and secure our services. Keep private order-status links confidential.",
    "<strong>Communicating with You:</strong> to provide customer support, respond to you, and maintain our business relationship.",
    "<strong>Legal Reasons:</strong> to comply with applicable law or valid legal process, including requests from law enforcement or government agencies, participate in legal proceedings, and enforce or investigate potential violations of our terms or policies.",
    "This storefront does not implement marketing subscriptions, personalized advertising, or cross-merchant advertising tracking.",
  ) +
  section(
    "How We Disclose Personal Information",
    "We may disclose personal information to vendors and other third parties who perform services on our behalf, including hosting, cloud storage, payment processing, customer support, fulfillment, shipping, and transactional email delivery.",
    "Cloudflare hosts the Services and stores order records and operational data. Stripe processes payment and tax information. Printful receives the delivery details and ordered products needed to fulfill and ship orders. Shipping carriers receive information needed for delivery.",
    "We may also disclose information when you direct, request, or consent to disclosure; with affiliates within our corporate group; in connection with a business transaction such as a merger or bankruptcy; to comply with legal obligations; to enforce our terms or policies; and to protect our rights and the rights of our users or others.",
    "We do not sell personal information or share it for targeted advertising through this storefront.",
  ) +
  section(
    "Relationship with Our Service Providers",
    'Information submitted to the Services may be transmitted to service providers in countries other than where you reside. Their processing is described in their own privacy notices: <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare</a>, <a href="https://stripe.com/privacy">Stripe</a>, and <a href="https://www.printful.com/policies/privacy">Printful</a>. Shopify no longer powers this storefront; purchases previously made through the Shopify store may remain subject to the notices that applied when those purchases were made.',
  ) +
  section(
    "Third Party Websites and Links",
    "The Services may provide links to websites or other online platforms operated by third parties. If you follow links to sites not affiliated or controlled by us, you should review their privacy and security policies and other terms and conditions. We do not guarantee and are not responsible for the privacy or security of such sites, including the accuracy, completeness, or reliability of information found on these sites. Information you provide on public or semi-public venues, including third-party social networking platforms, may be viewable by other users or third parties. Our inclusion of links does not, by itself, imply endorsement except as disclosed on the Services.",
  ) +
  section(
    "Children's Data",
    'The Services are not intended to be used by children, and we do not knowingly collect any personal information about children under the age of majority in your jurisdiction. If you are the parent or guardian of a child who has provided us with personal information, contact us to request deletion. As of the effective date of this Privacy Policy, we do not have actual knowledge that we "share" or "sell" (as defined in applicable law) personal information of individuals under 16 years of age.',
  ) +
  section(
    "Security and Retention of Your Information",
    'No security measures are perfect or impenetrable, and we cannot guarantee "perfect security." Information you send to us may not be secure while in transit. Do not use insecure channels to communicate sensitive or confidential information.',
    "How long we retain personal information depends on whether it is needed to provide the Services, comply with legal obligations, resolve disputes, or enforce contracts and policies. Private order-status links expire after 90 days; expiration of a link does not mean the underlying order records have been deleted.",
  ) +
  section(
    "Your Rights and Choices",
    "Depending on where you live, you may have rights to access or know about personal information, request deletion or correction, receive a portable copy, or request transfer to a third party. These rights are not absolute, may apply only in certain circumstances, and requests may be declined as permitted by law.",
    `You may also have a right to opt out of sale, sharing, or processing for targeted advertising. This storefront does not perform those activities. Contact ${contact} to exercise applicable rights, including requests concerning earlier purchases. There is no customer account or personalized advertising profile to opt out of on this storefront.`,
    "We send non-promotional communications about orders and customer support. The storefront has no promotional email subscription. Other than applicable Global Privacy Control rights, we do not recognize other browser Do Not Track signals.",
    "We will not discriminate against you for exercising your rights. We may need to verify your identity as permitted or required by law. You may designate an authorized agent where applicable; we require proof of authorization and may need to verify your identity directly. We respond in a timely manner as required by applicable law.",
  ) +
  section(
    "Complaints",
    "If you have complaints about how we process your personal information, please contact us. Depending on where you live, you may have the right to appeal our decision by contacting us or lodge a complaint with your local data protection authority.",
  ) +
  section(
    "International Transfers",
    "We may transfer, store and process personal information outside the country you live in.",
    "If we transfer personal information out of the European Economic Area or the United Kingdom, we rely on recognized transfer mechanisms such as the European Commission's Standard Contractual Clauses or equivalent UK contracts, unless the destination country has been determined to provide an adequate level of protection.",
  ) +
  section(
    "Changes to This Privacy Policy",
    'We may update this Privacy Policy to reflect changes to our practices or for operational, legal, or regulatory reasons. We will post the revised Privacy Policy, update the "Last updated" date and provide notice as required by applicable law.',
  ) +
  section(
    "Contact",
    `For questions about our privacy practices or to exercise your rights, email ${contact}. See our <a href="/policies/contact-information">contact information policy</a>.`,
  );

export const policyPages = [
  {
    route: "policies/refund-policy",
    title: "Refund policy",
    content: refundPolicy,
  },
  { route: "privacy", title: "Privacy policy", content: privacyPolicy },
  {
    route: "policies/privacy-policy",
    title: "Privacy policy",
    content: privacyPolicy,
  },
  { route: "terms", title: "Terms of service", content: termsPolicy },
  {
    route: "policies/terms-of-service",
    title: "Terms of service",
    content: termsPolicy,
  },
  {
    route: "policies/contact-information",
    title: "Contact information",
    content: paragraph(`Email: ${contact}`),
  },
  {
    route: "pages/contact",
    title: "Contact",
    content: paragraph(`Email: ${contact}`),
  },
  {
    route: "pages/data-sharing-opt-out",
    title: "Privacy choices",
    content: section(
      "Your privacy choices",
      `This storefront does not sell personal information or share it for targeted advertising. To exercise applicable privacy rights, including for earlier purchases, contact ${contact}. See our <a href="/privacy">Privacy Policy</a>.`,
    ),
  },
  {
    route: "shipping",
    title: "Shipping & returns",
    content:
      section(
        "Shipping and Delivery",
        `${freeShippingOffer} ${freeShippingDetails}`,
        "Products are made to order by Printful. Delivery availability, prices, and estimates are calculated for your items and destination before payment. International orders may incur customs or import charges.",
        "All delivery estimates are non-binding. Risk of loss and title for items pass to you upon delivery of the items to the shipping carrier. We are not liable for shipping delays outside our reasonable control.",
      ) + refundPolicy,
  },
];
