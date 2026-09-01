const { data } = JSON.parse(process.env.BASCIK_ROUTE || '{}');
console.log(`<h1 data-testid="unquoted-item-title">${data.title}</h1>`);
