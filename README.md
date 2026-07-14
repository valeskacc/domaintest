# test-hello-world

Minimaler Cloudflare Worker ("Hello World"), gedacht für `test.valeska.cc`.

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy
```

`valeska.cc` muss dabei als Zone im selben Cloudflare-Account liegen, mit dem `wrangler login` sich verbindet — Wrangler legt den Custom-Domain-Eintrag (`test.valeska.cc`) dann automatisch an (DNS-Record + Route).
