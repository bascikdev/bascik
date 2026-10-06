export default function () {
  const { data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
  return `<h1 data-testid="unquoted-item-title">${data.title}</h1>`;
}
