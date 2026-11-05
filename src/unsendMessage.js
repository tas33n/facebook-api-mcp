"use strict";

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
	return function unsendMessage(messageID, callback) {
		const operation = require("../lib/mqtt/LightSpeedRequest").completion(callback);
		const returnPromise = operation.promise;
		callback = operation.done;

		const form = {
			message_id: messageID
		};

		defaultFuncs
			.post(
				"https://www.facebook.com/messaging/unsend_message/",
				ctx.jar,
				form
			)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(function (resData) {
				if (resData.error) {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error("unsendMessage", err);
				return callback(err);
			});

		return returnPromise;
	};
};
