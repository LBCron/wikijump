const BENEFITS = [
  "unlimited number of members in private sites",
  "25 GB of storage for uploads",
  "each uploaded file can be up to 100MB",
  "SSL (secure connections)",
  "unlimited revisions for pages and files",
  "other small improvements"
]

export const renderWikidotManageSiteEducational = () => {
  const benefits = BENEFITS.map((benefit) => `<li>${benefit}</li>`).join("")
  return `<div class="page-header">
  <h1>Edu upgrade<small></small></h1>
</div>
<h2>Wikidot for educational purposes</h2>
<p>Wikidot offers a special upgrade for educational and research projects.</p>
<ul>${benefits}</ul>
<p>This upgrade is <strong>absolutely free</strong> and is applied after providing some basic information.</p>
<form id="sm-eduupgrade-form">
  <div class="control-group"><label>School / organization</label><textarea name="organization"></textarea></div>
  <div class="control-group"><label>How will you use this Wiki?</label><textarea name="purpose"></textarea></div>
  <div class="buttons form-actions"><div class="btn btn-primary" onclick="WIKIDOT.modules.ManageSiteAdminsModule.submit(event)">Please upgrade my site now</div></div>
</form>
<div class="alert alert-info">Educational upgrades are monitored to prevent abuse.</div>`
}
