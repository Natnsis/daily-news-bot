import express from 'express';

const app = express();

app.get('/', (_req, res) => {
  res.send('OK');
});

app.listen(3000, () => {
  console.log('server running on port:3000');
});
