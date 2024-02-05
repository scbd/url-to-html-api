module.exports = {
	tabCreated: (req, res, next) => {

		req.prerender.tab.Network.setExtraHTTPHeaders({
			headers: {
				'x-is-prerender': 'true'
			}
		});

		next();
	}
}