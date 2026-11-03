/** Unary loopback requests stay inside the attempt sandbox. Credentials enter only over stdin. */
export const HTTP_HELPER = `import sys, json, base64, http.client
request = json.load(sys.stdin)
connection = http.client.HTTPConnection("127.0.0.1", request["port"], timeout=request["timeoutMs"] / 1000)
try:
 connection.request(request.get("method", "GET"), request["path"], body=base64.b64decode(request.get("body", ""), validate=True), headers=request.get("headers", {}))
 response = connection.getresponse()
 headers = {}
 total = 0
 for name, value in response.getheaders():
  total += len(name.encode()) + len(value.encode())
  if total > 16384: raise ValueError("headers too large")
  key = name.lower()
  headers[key] = headers[key] + ", " + value if key in headers else value
 body = response.read(request["maxResponseBytes"] + 1)
 if len(body) > request["maxResponseBytes"]: raise ValueError("body too large")
 print(json.dumps({"status": response.status, "headers": headers, "body": base64.b64encode(body).decode("ascii")}), end="")
finally: connection.close()
`;
