export interface ProductionConfig {
  name: string;
  account_id: string;
  vars: Record<string, string>;
  routes?: unknown;
  workers_dev: boolean;
  d1_databases: {
    binding: string;
    database_name: string;
    database_id: string;
  }[];
  queues: {
    producers: { binding: string; queue: string }[];
    consumers: { queue: string; dead_letter_queue: string }[];
  };
  send_email: { name: string; allowed_sender_addresses: string[] }[];
}

export function assertProductionPrelaunch(config: ProductionConfig) {
  if (
    config.name !== "bascik-shop-production" ||
    config.account_id !== "8572c3fcc06b71dbf05fe590e8b3f74e" ||
    config.workers_dev !== true ||
    config.routes !== undefined ||
    config.vars?.SHOP_MODE !== "live" ||
    config.vars.SHOP_ENABLED !== "false" ||
    config.vars.SHOP_FULFILLMENT_ENABLED !== "false" ||
    config.vars.PRINTFUL_STORE_ID !== "19022802" ||
    config.vars.SHOP_ORIGIN !==
      "https://bascik-shop-production.collin-inbox.workers.dev" ||
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== "DB" ||
    config.d1_databases[0].database_name !== "bascik-shop-production-db" ||
    config.d1_databases[0].database_id !==
      "6789dbf6-f32f-400b-ad4a-d5b590b7438d" ||
    config.queues?.producers?.length !== 1 ||
    config.queues.producers[0].binding !== "JOBS" ||
    config.queues.producers[0].queue !== "bascik-shop-production-jobs" ||
    config.queues.consumers?.length !== 1 ||
    config.queues.consumers[0].queue !== "bascik-shop-production-jobs" ||
    config.queues.consumers[0].dead_letter_queue !==
      "bascik-shop-production-dead" ||
    config.vars.EMAIL_FROM !== "no-reply@bascik.dev" ||
    config.send_email?.length !== 1 ||
    config.send_email[0].name !== "EMAIL" ||
    config.send_email[0].allowed_sender_addresses?.length !== 1 ||
    config.send_email[0].allowed_sender_addresses[0] !== config.vars.EMAIL_FROM
  )
    throw new Error("Unsafe production prelaunch configuration.");
}
