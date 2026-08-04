import 'dotenv/config';

const TOKEN = process.env.GHL_API_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;

const res = await fetch(
  `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOCATION_ID}`,
  {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Version: '2021-07-28',
      Accept: 'application/json',
    },
  }
);
const data = await res.json();

console.log('All pipelines:');
data.pipelines.forEach((p) => console.log(`  ${p.name}  ->  ${p.id}`));

console.log('\n--- To see stages for one pipeline, edit the name below ---\n');

const target = data.pipelines.find((p) =>
  p.name.toLowerCase().includes('buyer') // change 'buyer' to match any pipeline name
);

if (target) {
  console.log('Pipeline:', target.name, '| ID:', target.id);
  console.log('Stages:');
  target.stages.forEach((s) => console.log(`  ${s.name}  ->  ${s.id}`));
} else {
  console.log('No match found for that filter.');
}