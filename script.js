async function gettrainData() {
    const trainsdata = [];
    const req = await fetch('http://lapi.transitchicago.com/api/1.0/ttpositions.aspx?key=YOUR_CTA_KEY&rt=red&outputType=JSON', { headers: { 'Access-Control-Allow-Origin': '*' } });
    const data = await req.json();
    if (req.ok()) {
        console.log(data);
        trainsdata = data;
        return trainsdata;
    } else {
        console.log(`error: ${req.status} ${req.statusText}`);
    }
};
gettrainData();
