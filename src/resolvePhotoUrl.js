"use strict";

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
	return function resolvePhotoUrl(photoID, callback) {
		const operation = require("../lib/mqtt/LightSpeedRequest").completion(callback);
		const returnPromise = operation.promise;
		callback = operation.done;

		defaultFuncs
			.get("https://www.facebook.com/mercury/attachments/photo", ctx.jar, {
				photo_id: photoID
			})
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(resData => {
				if (resData.error) {
					throw resData;
				}

				const photoUrl = resData.jsmods.require[0][3][0];

				return callback(null, photoUrl);
			})
			.catch(err => {
				log.error("resolvePhotoUrl", err);
				return callback(err);
			});

		return returnPromise;
	};
};
