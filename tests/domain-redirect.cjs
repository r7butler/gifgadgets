const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('terraform/main.tf', 'utf8');
const code = source.split('resource "aws_cloudfront_function" "rewrite_index"')[1].split('code = <<-EOF')[1].split('\n  EOF')[0];
const context = vm.createContext({});
vm.runInContext(code.replace('${var.enable_domain_redirect}', 'true'), context);
function request(host, uri, querystring = {}) {
  return context.handler({request: {headers: {host: {value: host}}, uri, querystring}});
}
for (const host of ['gifwidgets.com', 'www.gifgadgets.com']) {
  assert.equal(request(host, '/').headers.location.value, 'https://gifgadgets.com/');
  const result = request(host, '/gif-resizer/', {a: {multiValue: [{value: 'x%20y'}, {value: 'z%26b'}]}, empty: {value: ''}});
  assert.equal(result.statusCode, 301);
  assert.equal(result.headers.location.value, 'https://gifgadgets.com/gif-resizer/?a=x%20y&a=z%26b&empty=');
}
assert.equal(request('gifgadgets.com', '/gif-resizer/').uri, '/gif-resizer/index.html');
assert.equal(request('gifgadgets.com', '/robots.txt').uri, '/robots.txt');
vm.runInContext(code.replace('${var.enable_domain_redirect}', 'false'), context);
assert.equal(request('gifwidgets.com', '/gif-resizer/').uri, '/gif-resizer/index.html');
console.log('Domain redirect checks passed');
