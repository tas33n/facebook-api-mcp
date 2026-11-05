"use strict";

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
	return function markAsReadAll(callback) {
		const operation = require("../lib/mqtt/LightSpeedRequest").completion(callback);
		const returnPromise = operation.promise;
		callback = operation.done;

		const form = {
			folder: 'inbox'
		};

		defaultFuncs
			.post(
				"https://www.facebook.com/ajax/mercury/mark_folder_as_read.php",
				ctx.jar,
				form
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
				log.error("markAsReadAll", err);
				return callback(err);
			});

		return returnPromise;
	};
};
