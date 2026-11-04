import { WIKIDOT_SITE_LANGUAGES } from "../admin/wikidot-site-languages.ts"

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const renderLanguageOptions = (locale: string) =>
  ["Stable", "Experimental"]
    .map((group) => {
      const options = WIKIDOT_SITE_LANGUAGES.filter((entry) => entry.group === group)
        .map(({ value, label }) => {
          const escapedValue = escapeHtml(value)
          const escapedLabel = escapeHtml(label)
          const selected = value === locale ? ' selected="selected"' : ""
          return `<option label="${escapedLabel}" value="${escapedValue}"${selected}>${escapedLabel}</option>`
        })
        .join("\n")
      return `<optgroup label="${group}">\n${options}\n</optgroup>`
    })
    .join("\n")

export const renderWikidotManageSiteGeneral = (site: {
  slug: string
  name: string
  tagline: string
  locale: string
  description: string
  default_page: string
  welcome_page: string
}) => {
  const slug = escapeHtml(site.slug)
  const name = escapeHtml(site.name)
  const tagline = escapeHtml(site.tagline)
  const description = escapeHtml(site.description)
  const defaultPage = escapeHtml(site.default_page)
  const welcomePage = escapeHtml(site.welcome_page)
  const languageOptions = renderLanguageOptions(site.locale)

  return `<div class="page-header">
  <h1>Wiki Settings<small>The most important things for your Wiki</small></h1>
</div>

${"\x20\x20"}
<div class="error-block alert alert-error" style="display: none;">
	<div class="error-block-title">Error!</div>
	<div class="error-block-message"></div>
</div>
${"\x20"}

<form id="sm-general-form" class="form-horizontal">
			<div class="control-group">
			<label class="control-label">Wiki address</label>
			<div class="controls">
				<div class="input-append">
${"\t\t\t  \t\t"}<input class="span2" id="appendedInput" type="text" name="unixName" value="${slug}">
${"\t\t\t  \t\t"}<span class="add-on">.wikidot.com</span>
				</div>
			</div>
		</div>${"\t"}
		<div class="control-group">
		<label class="control-label">Wiki title</label>
		<div class="controls">
			<input class="text" type="text" name="name" size="40" value="${name}"/>
		</div>
	</div>
${"\t"}
	<div class="control-group">
		<label class="control-label">Tagline / subtitle</label>
		<div class="controls">
			<input class="text" type="text" name="subtitle" size="40" value="${tagline}"/>
		</div>
	</div>
${"\t"}
		<div class="control-group">
		<label class="control-label">Language</label>
		<div class="controls">
            <select name="language" id="sm-general-language">
${languageOptions}
</select>

            <span class="help-block">
                Missing your language? Translation incomplete?<br/>                     Help us <a href="http://translate.wikidot.com">translate Wikidot!</a>            </span>
		</div>
	</div>
${"\t"}
${"\t"}
	<div class="control-group">
		<label class="control-label">Description</label>
		<div class="controls">
			<textarea name="description" id="site-description-field" cols="40" rows="3">${description}</textarea>
			<span class="help-block">
				Please keep it short. <span id="site-description-field-left"></span> characters left.			</span>
		</div>
	</div>
${"\t"}
	<div class="accordion" id="accordion2">
	  <div class="accordion-group">
	    <div class="accordion-heading">
	      <a class="accordion-toggle" data-toggle="collapse" data-parent="#accordion2" href="#collapseOne">
	        <i class="icon-reorder"></i> Advanced Settings	      </a>
	    </div>
	    <div id="collapseOne" class="accordion-body collapse">
	      <div class="accordion-inner">
					<div class="control-group">
						<label class="control-label">Default start page</label>
						<div class="controls">
							<div class="autocomplete-container">
								<input type="text" id="sm-general-start" class="autocomplete-input text" name="default_page" size="35" value="${defaultPage}"/>
								<div id="sm-general-start-list" class="autocomplete-list"></div>
							</div>
							<div class="sub">
								Which page will be displayed when people just type http://${slug}.wikidot.com?							</div>
						</div>
					</div>
${"\t\t\t\t  \t"}
					<div class="control-group">
						<label class="control-label">Welcome page for new members</label>
						<div class="controls">
							<div class="autocomplete-container">
								<input type="text" id="sm-general-welcome" class="autocomplete-input text" name="welcome_page" size="35" value="${welcomePage}"/>
								<div id="sm-general-welcome-list" class="autocomplete-list"></div>
							</div>
						</div>
					</div>
${"\t\t\t\t\t"}
			  </div>
			</div>
		</div>
	</div>
	<div class="buttons form-actions">
		<div class="btn btn-primary" id="sm-general-save">
			 <i class='icon-save'></i> Save changes		</div>
	</div>
</form>

<div id="message" class="modal hide fade" tabindex="-1" role="dialog" aria-labelledby="myModalLabel" aria-hidden="true">
  <div class="modal-body">
	<div class="spinner">
		<i class="icon-spinner icon-spin icon-2x"></i>
	</div>
	<div class="saved" style="display: none;">
    <h3>Changes saved.</h3>
	</div>
  </div>
</div>`
}
