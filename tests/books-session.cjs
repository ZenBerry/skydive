const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let book = {id: 1, name: 'Fixture', src: 'https://example.test/book.epub'};
const collection = {
  createIndex: async () => {},
  findOne: async () => book,
  findOneAndUpdate: async (_query, update) => (book = {...book, ...update.$set})
};
const sandbox = {
  exports: {}, process: {env: {MONGODB_URI: 'mock'}}, URL, console,
  require: () => ({MongoClient: class {
    async connect() {}
    db() { return {collection: () => collection}; }
  }})
};
vm.runInNewContext(fs.readFileSync(require.resolve('../netlify/functions/books.js'), 'utf8'), sandbox);
(async () => {
  const handler = sandbox.exports.handler;
  const session = {
    id: 1, position: {pageIndex: 5, progress: .2, textOffset: 1234, updatedAt: 100},
    highlights: [{id:'test',start:10,end:20,color:'#ffd4b570',text:'a passage'}],
    markHistory: [{role:'user',content:'Discuss this passage'}]
  };
  assert.equal((await handler({httpMethod:'POST',body:JSON.stringify(session)})).statusCode,200);
  const result = JSON.parse((await handler({httpMethod:'GET',queryStringParameters:{id:'1'}})).body).book;
  assert.deepEqual(result.position,session.position);
  assert.deepEqual(result.highlights,session.highlights);
  assert.deepEqual(result.markHistory,session.markHistory);
  await handler({httpMethod:'POST',body:JSON.stringify({id:1,position:{pageIndex:2,progress:.1,textOffset:-2}})});
  assert.equal(book.position.textOffset,null);
  console.log('PASS: DB session round trip preserves text anchor, translucent highlights and Mark history; invalid anchor rejected');
})().catch(e => {console.error(e);process.exitCode=1;});
