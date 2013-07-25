/*global define:true, ga:true*/
define(['jquery', 'Utils', '../../socket', 'Params', 'knockout', 'm/_moduleCliche', 'globalVM', 'model/storage', 'model/User', 'KeyHandler', 'text!tpl/common/auth.jade', 'css!style/common/auth'], function ($, Utils, socket, P, ko, Cliche, globalVM, storage, User, keyTarget, jade) {
	'use strict';

	return Cliche.extend({
		jade: jade,
		create: function () {
			this.iAm = User.vm();
			this.loggedIn = ko.observable(false);

			this.mode = ko.observable('');
			this.working = ko.observable(false);
			this.finish = ko.observable(false);

			this.login = ko.observable('');
			this.key = ko.observable('');

			this.avatar = ko.observable('');
			this.name = ko.observable('');


			this.msg = ko.observable('');
			this.caps = ko.observable(false);

			this.subscriptions.mode = this.mode.subscribe(function () {
				this.formFocus();
			}, this);

			ko.applyBindings(globalVM, this.$dom[0]);
		},
		show: function (mode, callback, ctx) {
			if (mode) {
				this.mode(mode);
			}

			if (callback) {
				this.callback = callback;
				this.ctx = ctx || window;
			}

			globalVM.func.showContainer(this.$container, function () {
				this.showing = true;
				this.formFocus();

				keyTarget.push({
					id: 'authOverlay',
					stopFurther: false,
					onEsc: this.formClose.bind(this)
				});
			}, this);
		},
		hide: function () {
			keyTarget.pop();
			this.formReset();
			globalVM.func.hideContainer(this.$container);
			this.showing = false;
		},

		showPassChangeRecall: function (data, key, callback, ctx) {
			this.login(data.login);
			this.name(data.disp);
			this.avatar(data.avatar);
			this.key(key);
			this.show('passChangeRecall', callback, ctx);
		},

		pressHandler: function (vm, event) {
			this.caps(Utils.capsLockDetect(event));
			return true;
		},

		formFocus: function () {
			window.setTimeout(function () {
				try {
					this.$dom.children('form:visible')[0].querySelector('input:first-child:not([disabled])').focus();
				} catch (e) {
				}
			}.bind(this), 200);
		},
		formReset: function () {
			this.$dom.find(':focus').blur();
			this.$dom.find("input").val(null);
			this.$dom.find(".mess").height(0).removeClass('text-error text-warning text-info text-success muted');
			this.mode('');
			this.login('');
			this.name('');
			this.avatar('');
			this.key('');
			this.msg('');
			delete this.callback;
			delete this.ctx;
			this.formWorking(false);
			this.finish(false);
			this.caps(false);
		},
		formClose: function () {
			if (Utils.isType('function', this.callback)) {
				this.callback.call(this.ctx, {loggedIn: false});
			}
			this.hide();
		},
		formWorking: function (param) {
			this.working(param);
			this.$dom.find('form:visible').find('input, button').attr('disabled', param);
		},
		setMessage: function (text, type) {
			var css = '';
			switch (type) {
			case 'error':
				css = 'text-error';
				break;
			case 'warn':
				css = 'text-warning';
				break;
			case 'info':
				css = 'text-info';
				break;
			case 'success':
				css = 'text-success';
				break;
			default:
				css = 'muted';
				break;
			}

			this.msg(text);
			this.$dom.find('form:visible .mess')
				.addClass(css)
				.css({height: 5 + this.$dom.find('form:visible .mess > div').height()});

			text = type = css = null;
		},

		submit: function (data, evt) {
			var $form = $(evt.target);
			$form.find(':focus').blur();

			try {
				if (this.mode() === 'login') {
					this.doLogin(
						$.extend($form.serializeObject(), {'remember': $form[0].querySelector('#remember').classList.contains('checked')}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formWorking(false);
									this.formFocus();
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'login', 'error');
							} else {
								if (Utils.isType('function', this.callback)) {
									this.callback.call(this.ctx, {loggedIn: true});
								}
								this.hide();
								ga('send', 'event', 'auth', 'login', 'success');
							}
						}.bind(this)
					);
				} else if (this.mode() === 'reg') {
					this.doRegister(
						$.extend($form.serializeObject(), {}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formFocus();
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'register', 'error');
							} else {
								this.finish(true);
								this.setMessage(data.message, 'success');
								window.setTimeout(function () {
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'register', 'success');
							}
						}.bind(this)
					);
				} else if (this.mode() === 'recallRequest') {
					this.doPassRecall(
						$.extend($form.serializeObject(), {}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formFocus();
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passRecall', 'error');
							} else {
								this.finish(true);
								this.setMessage(data.message, 'success');
								window.setTimeout(function () {
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passRecall', 'success');
							}
						}.bind(this)
					);
				} else if (this.mode() === 'passChangeRecall') {
					this.doPassRecallChange(
						$.extend($form.serializeObject(), {key: this.key()}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formFocus();
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passChangeRecall', 'error');
							} else {
								this.finish(true);
								this.setMessage(data.message, 'success');
								window.setTimeout(function () {
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passChangeRecall', 'success');
							}
						}.bind(this)
					);
				} else if (this.mode() === 'recallRequestForMe') {
					this.doPassRecall(
						$.extend($form.serializeObject(), {login: this.iAm.login()}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formFocus();
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'recallRequestFor', 'error');
							} else {
								this.finish(true);
								this.setMessage(data.message, 'success');
								window.setTimeout(function () {
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'recallRequestFor', 'success');
							}
						}.bind(this)
					);
				} else if (this.mode() === 'passChange') {
					this.doPassChange(
						$.extend($form.serializeObject(), {login: this.iAm.login()}),
						function (data) {
							if (data.error) {
								this.setMessage(data.message, 'error');
								window.setTimeout(function () {
									this.formFocus();
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passChange', 'error');
							} else {
								this.finish(true);
								this.setMessage(data.message, 'success');
								window.setTimeout(function () {
									this.formWorking(false);
								}.bind(this), 420);
								ga('send', 'event', 'auth', 'passChange', 'success');
							}
						}.bind(this)
					);
				}

				this.formWorking(true);
			} catch (e) {
				this.setMessage(e.message, 'error');
				this.formWorking(false);
			}

			return false;
		},

		processMe: function (user) {
			this.iAm = User.vm(user, this.iAm);
			storage.users[user.login] = {origin: user, vm: this.iAm};
			this.loggedIn(true);

			//При изменении данных профиля на сервере, обновляем его на клиенте
			socket
				.removeAllListeners('youAre')
				.on('youAre', function (user) {
					if (this.iAm.login() === user.login) {
						storage.users[user.login].origin = user;
						this.iAm = User.vm(user, this.iAm);
						this.iAm._v_(this.iAm._v_() + 1);
					}
				}.bind(this));
		},
		loadMe: function () {
			var dfd = $.Deferred();
			socket.once('youAre', function (user) {
				if (user) {
					this.processMe(user);
				}
				// Резолвим асинхронно, чтобы пересчитались computed зависимости других модулей от auth
				window.setTimeout(dfd.resolve.bind(dfd), 50);
			}.bind(this));
			socket.emit('whoAmI');
			return dfd.promise();
		},
		doLogin: function (data, callback) {
			try {
				socket.once('loginResult', function (json) {
					if (!json.error && json.youAre) {
						this.processMe(json.youAre);
					}

					if (Utils.isType('function', callback)) {
						callback(json);
					}
				}.bind(this));
				socket.emit('loginRequest', data);
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		},
		doLogout: function (callback) {
			ga('send', 'event', 'auth', 'logout');
			try {
				socket.once('logoutResult', function (json) {
					if (json.error) {
						console.log('Logout error: ' + json.message);
					} else {
						Utils.cookie.removeItem('pastvu.sid', '/');
						if (json.logoutPath) {
							document.location = json.logoutPath;
						} else {
							location.reload();
						}
					}
				});
				socket.emit('logoutRequest', {});
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		},
		doRegister: function (data, callback) {
			try {
				socket.once('registerResult', function (json) {
					if (Utils.isType('function', callback)) {
						callback(json);
					}
				});
				socket.emit('registerRequest', data);
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		},
		doPassRecall: function (data, callback) {
			try {
				socket.once('recallResult', function (json) {
					if (Utils.isType('function', callback)) {
						callback(json);
					}
				});
				socket.emit('recallRequest', data);
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		},
		doPassRecallChange: function (data, callback) {
			try {
				socket.once('passChangeRecallResult', function (json) {
					if (Utils.isType('function', callback)) {
						callback(json);
					}
				});
				socket.emit('passChangeRecall', data);
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		},
		doPassChange: function (data, callback) {
			try {
				socket.once('passChangeResult', function (json) {
					if (Utils.isType('function', callback)) {
						callback(json);
					}
				});
				socket.emit('passChangeRequest', data);
			} catch (e) {
				if (Utils.isType('function', callback)) {
					callback(e.message);
				}
			}
		}

	});
});