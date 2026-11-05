"use strict";

const utils = require("../utils");
const log = require("npmlog");
const { completion } = require("../lib/mqtt/LightSpeedRequest");

module.exports = function (defaultFuncs, api, ctx) {
	return function changeBlockedStatus(userID, block, callback) {
		const operation = completion(callback);
		callback = operation.done;
		const returnPromise = operation.promise;
		if (!userID || typeof block !== "boolean") {
			callback(new TypeError("userID and boolean block are required"));
			return returnPromise;
		}

		defaultFuncs
			.post(
				`https://www.facebook.com/messaging/${block ? "" : "un"}block_messages/`,
				ctx.jar,
				{
					fbid: userID
				}
			)
			.then(utils.saveCookies(ctx.jar))
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error("changeBlockedStatus", err);
				return callback(err);
			});
		return returnPromise;
	};
};
