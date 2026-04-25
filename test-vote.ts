async function test() {
  const shareRes = await fetch("http://localhost:3000/api/ideas/share", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ idea: [{concepto:"test", visual:"foo", tipo:"FOO"}] })
  });
  const { id } = await shareRes.json();
  console.log("Shared:", id);

  const voteRes = await fetch(`http://localhost:3000/api/ideas/${id}/vote/0`, {
    method: "POST"
  });
  console.log("Vote 1:", await voteRes.json());
  
  const getRes = await fetch(`http://localhost:3000/api/ideas/${id}`);
  console.log("Get:", await getRes.json());
}
test();
