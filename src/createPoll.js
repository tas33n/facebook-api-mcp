"use strict";

const utils = require("../utils");
const log = require("npmlog");

module.exports = function (defaultFuncs, api, ctx) {
	return function createPoll(title, threadID, options, callback) {
		if (typeof options === "function") { callback = options; options = null; }
		const operation = require("../lib/mqtt/LightSpeedRequest").completion(callback);
		const returnPromise = operation.promise;
		callback = operation.done;
		if (!options) {
			options = {}; // Initial poll options are optional
		}

		const form = {
			target_id: threadID,
			question_text: title
		};

		// Set fields for options (and whether they are selected initially by the posting user)
		let ind = 0;
		for (const opt in options) {
			// eslint-disable-next-line no-prototype-builtins
			if (Object.prototype.hasOwnProperty.call(options, opt)) {
				form["option_text_array[" + ind + "]"] = opt;
				form["option_is_selected_array[" + ind + "]"] = options[opt]
					? "1"
					: "0";
				ind++;
			}
		}

		defaultFuncs
			.post(
				"https://www.facebook.com/messaging/group_polling/create_poll/?dpr=1",
				ctx.jar,
				form
			)
			.then(utils.parseAndCheckLogin(ctx, defaultFuncs))
			.then(function (resData) {
				if (resData.error || resData.payload?.status !== "success") {
					throw resData;
				}

				return callback();
			})
			.catch(function (err) {
				log.error("createPoll", err);
				return callback(err);
			});

		return returnPromise;
	};
};
