'use strict';

var auth = require('./auth.js'),
	_session = require('./_session.js'),
	Settings,
	User,
	UserCommentsView,
	UserSelfPublishedPhotos,
	Photo,
	PhotoMap,
	PhotoFresh,
	PhotoDis,
	PhotoDel,
	PhotoSort,
	Comment,
	Counter,
	UserSubscr,
	regionController = require('./region.js'),
	PhotoCluster = require('./photoCluster.js'),
	PhotoConverter = require('./photoConverter.js'),
	_ = require('lodash'),
	fs = require('fs'),
	ms = require('ms'), // Tiny milisecond conversion utility
	moment = require('moment'),
	step = require('step'),
	async = require('async'),
	Utils = require('../commons/Utils.js'),
	log4js = require('log4js'),
	logger,
	incomeDir = global.appVar.storePath + 'incoming/',
	privateDir = global.appVar.storePath + 'private/photos/',
	publicDir = global.appVar.storePath + 'public/photos/',
	imageFolders = ['x/', 's/', 'q/', 'm/', 'h/', 'd/', 'a/'],

	subscrController = require('./subscr.js'),
	commentController = require('./comment.js'),
	msg = {
		deny: 'You do not have permission for this action',
		notExists: 'Requested photo does not exist',
		anotherStatus: 'Фотография уже в другом статусе, обновите страницу'
	},

	shift10y = ms('10y'),
	compactFields = {_id: 0, cid: 1, file: 1, ldate: 1, adate: 1, title: 1, year: 1, ccount: 1, conv: 1, convqueue: 1, ready: 1},
	compactFieldsId = {_id: 1, cid: 1, file: 1, ldate: 1, adate: 1, title: 1, year: 1, ccount: 1, conv: 1, convqueue: 1, ready: 1},
	photoPermissions = {
		canModerate: function (photo, user) {
			var rhash,
				photoRegion,
				i;

			//Если у пользователя роль модератора регионов, смотрим его регионы,
			//и если фотография принадлежит одному из них, значит пользователь может её модерировать
			if (user && user.role === 5) {
				rhash = _session.us[user.login].mod_rhash;
				for (i = 0; i < 5; i++) {
					photoRegion = photo['r' + i];
					if (photoRegion && rhash[photoRegion] !== undefined) {
						return true;
					}
				}
			}
			return false;
		},
		getCan: function (photo, user) {
			var can = {
					edit: false,
					disable: false,
					remove: false,
					approve: false,
					convert: false
				},
				ownPhoto,
				canModerate;

			if (user) {
				ownPhoto = photo.user && photo.user.equals(user._id);
				canModerate = user.role > 5 || photoPermissions.canModerate(photo, user);

				can.edit = canModerate || ownPhoto;
				can.remove = canModerate || photo.fresh && ownPhoto; //Пока фото новое, её может удалить и владелец
				if (canModerate) {
					can.disable = true;
					if (photo.fresh) {
						can.approve = true;
					}
					if (user.role > 9) {
						can.convert = true;
					}
				}
			}
			return can;
		},
		canSee: function (photo, user) {
			if (photo.s === 5) {
				return true;
			} else if (user && photo.user) {
				if (photo.s === 9) {
					return user.role > 9;
				} else {
					return photo.user.equals(user._id) || photoPermissions.canModerate(photo, user);
				}
			}

			return false;
		}
	};

/**
 * Создает фотографии в базе данных
 * @param socket Сессия пользователя
 * @param data Объект или массив фотографий
 * @param cb Коллбэк
 */
var dirs = ['w', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'aero'];
function createPhotos(socket, data, cb) {
	var user = socket.handshake.session.user;
	if (!user) {
		return cb({message: msg.deny, error: true});
	}
	if (!data || (!Array.isArray(data) && !Utils.isType('object', data))) {
		return cb({message: 'Bad params', error: true});
	}

	if (!Array.isArray(data) && Utils.isType('object', data)) {
		data = [data];
	}

	var result = [],
		canCreate = 0;

	if (user.ranks && (~user.ranks.indexOf('mec_silv') || ~user.ranks.indexOf('mec_gold'))) {
		canCreate = Infinity; //Серебряный и золотой меценаты имеют неограниченный лимит
	} else if (user.ranks && ~user.ranks.indexOf('mec')) {
		canCreate = Math.max(0, 100 - user.pfcount); //Меценат имеет лимит 100
	} else if (user.pcount < 25) {
		canCreate = Math.max(0, 3 - user.pfcount);
	} else if (user.pcount < 50) {
		canCreate = Math.max(0, 5 - user.pfcount);
	} else if (user.pcount < 200) {
		canCreate = Math.max(0, 10 - user.pfcount);
	} else if (user.pcount < 1000) {
		canCreate = Math.max(0, 50 - user.pfcount);
	} else if (user.pcount >= 1000) {
		canCreate = Math.max(0, 100 - user.pfcount);
	}

	if (!canCreate || !data.length) {
		cb({message: 'Nothing to save', cids: result});
	}
	if (data.length > canCreate) {
		data = data.slice(0, canCreate);
	}

	step(
		function filesToPrivateFolder() {
			var item,
				i = data.length;

			while (i--) {
				item = data[i];
				item.fullfile = item.file.replace(/((.)(.)(.))/, "$2/$3/$4/$1");
				fs.rename(incomeDir + item.file, privateDir + item.fullfile, this.parallel());
			}
		},
		function increment(err) {
			if (err) {
				return cb({message: err.message || 'File transfer error', error: true});
			}
			Counter.incrementBy('photo', data.length, this);
		},
		function savePhotos(err, count) {
			if (err || !count) {
				return cb({message: err && err.message || 'Increment photo counter error', error: true});
			}
			var photo,
				now = Date.now(),
				next = count.next - data.length + 1,
				item,
				i;

			for (i = 0; i < data.length; i++) {
				item = data[i];

				photo = new Photo({
					cid: next + i,
					user: user._id,
					file: item.fullfile,
					ldate: new Date(now + i * 10), //Время загрузки каждого файла инкрементим на 10мс для правильной сортировки
					type: item.type,
					size: item.size,
					geo: undefined,
					s: 0,
					title: item.name ? item.name.replace(/(.*)\.[^.]+$/, '$1') : undefined, //Отрезаем у файла расширение
					frags: undefined,
					convqueue: true
					//geo: [_.random(36546649, 38456140) / 1000000, _.random(55465922, 56103812) / 1000000],
					//dir: dirs[_.random(0, dirs.length - 1)],
				});
				item.photoObj = photo;

				result.push({cid: photo.cid});
				photo.save(this.parallel());
			}
		},
		function (err) {
			if (err) {
				return cb({message: err.message, error: true});
			}
			user.pfcount = user.pfcount + data.length;
			_session.saveEmitUser(user.login, null, socket, this);
		},
		function (err) {
			if (err) {
				return cb({message: err.message, error: true});
			}
			cb({message: data.length + ' photo successfully saved', cids: result});
		}
	);
}

function changePublicPhotoExternality(socket, photo, iAm, makePublic, cb) {
	step(
		function () {
			//Скрываем или показываем комментарии и пересчитываем их публичное кол-во у пользователей
			commentController.hideObjComments(photo._id, !makePublic, iAm, this.parallel());

			//Пересчитывам кол-во публичных фото у владельца фотографии
			var user = _session.getOnline(null, photo.user);
			if (user) {
				user.pcount = user.pcount + (makePublic ? 1 : -1);
				_session.saveEmitUser(null, photo.user);
			} else {
				User.update({_id: photo.user}, {$inc: {pcount: makePublic ? 1 : -1}}, this.parallel());
			}

			//Если у фото есть координаты, значит надо провести действие с картой
			if (Utils.geoCheck(photo.geo)) {
				if (makePublic) {
					photoToMap(photo, null, null, this.parallel());
				} else {
					photoFromMap(photo, this.parallel());
				}
			}
		},
		function (err) {
			cb(err);
		}
	);
}

//Добавляет фото на карту
function photoToMap(photo, geoPhotoOld, yearPhotoOld, cb) {
	step(
		function () {
			PhotoCluster.clusterPhoto(photo, geoPhotoOld, yearPhotoOld, this.parallel()); 	//Отправляем на кластеризацию
			PhotoMap.update(
				{cid: photo.cid},
				{
					$setOnInsert: {cid: photo.cid},
					$set: {
						cid: photo.cid,
						geo: photo.geo,
						file: photo.file,
						dir: photo.dir,
						title: photo.title,
						year: photo.year,
						year2: photo.year2
					}
				},
				{upsert: true},
				this.parallel()
			);
		},
		function (err) {
			if (cb) {
				cb(err);
			}
		}
	);
}
//Удаляет фото с карты
function photoFromMap(photo, cb) {
	step(
		function () {
			PhotoCluster.declusterPhoto(photo, this.parallel());
			PhotoMap.remove({cid: photo.cid}, this.parallel());
		},
		function (err) {
			if (cb) {
				cb(err);
			}
		}
	);
}

//Удаляет из Incoming загруженное, но не созданное фото
function removePhotoIncoming(socket, data, cb) {
	var user = socket.handshake.session.user;
	if (!user) {
		return cb({message: msg.deny, error: true});
	}

	fs.unlink(incomeDir + data.file, cb);
}

/**
 * Удаление фотографии
 * @param socket Сокет пользователя
 * @param cid
 * @param cb Коллбэк
 */
function removePhoto(socket, cid, cb) {
	var iAm = socket.handshake.session.user;

	if (!iAm) {
		return cb({message: msg.deny, error: true});
	}
	cid = Number(cid);
	if (!cid) {
		return cb({message: 'Bad params', error: true});
	}

	findPhoto({cid: cid}, {}, iAm, function (err, photo) {
		if (err || !photo) {
			return cb({message: err && err.message || 'No such photo', error: true});
		}

		if (photo.s === 0 || photo.s === 1) {
			//Неподтвержденную фотографию удаляем безвозвратно
			photo.remove(function (err) {
				if (err) {
					return cb({message: err.message, error: true});
				}

				var user = _session.getOnline(null, photo.user);

				//Пересчитывам кол-во новых фото у владельца
				if (user) {
					user.pfcount = user.pfcount - 1;
					_session.saveEmitUser(user.login);
				} else {
					User.update({_id: photo.user}, {$inc: {pfcount: -1}}).exec();
				}

				//Удаляем из конвейера если есть
				PhotoConverter.removePhotos([photo.cid]);

				//Удаляем файлы фотографии
				fs.unlink(privateDir + photo.file, Utils.dummyFn);
				imageFolders.forEach(function (folder) {
					fs.unlink(publicDir + folder + photo.file, Utils.dummyFn);
				});

				cb({message: 'ok'});
			});
		} else {
			var isPublic = photo.s === 5;

			photo.s = 9;
			photo.save(function (err, photoSaved) {
				if (err) {
					return cb({message: err && err.message, error: true});
				}
				if (isPublic) {
					changePublicPhotoExternality(socket, photoSaved, iAm, false, function (err) {
						if (err) {
							return cb({message: err && err.message, error: true});
						}
						cb({message: 'ok'});
					});
				}
			});
		}
	});
}

//Подтверждаем новую фотографию
function approvePhoto(iAm, cid, cb) {
	cid = Number(cid);
	if (!cid) {
		return cb({message: msg.notExists, error: true});
	}

	Photo.findOne({cid: cid}, function (err, photo) {
		if (err) {
			return cb({message: err.message, error: true});
		}
		if (!photo) {
			return cb({message: msg.notExists, error: true});
		}
		if (photo.s !== 0 && photo.s !== 1) {
			return cb({message: msg.anotherStatus, error: true});
		}

		photo.adate = new Date();
		photo.save(function (err, photoSaved) {
			if (err) {
				return cb({message: err && err.message, error: true});
			}
			cb({message: 'Photo approved successfully'});

			if (Utils.geoCheck(photoSaved.geo)) {
				photoToMap(photoSaved);
			}

			//Обновляем количество у автора фотографии
			var user = _session.getOnline(null, photoSaved.user);
			if (user) {
				user.pcount = user.pcount + 1;
				user.pfcount = user.pfcount - 1;
				_session.saveEmitUser(user.login);
			} else {
				User.update({_id: photoSaved.user}, {$inc: {pcount: 1, pfcount: -1}}).exec();
			}

			//Подписываем автора фотографии на неё
			subscrController.subscribeUserByIds(photoSaved.user, photoSaved._id, 'photo');
		});
	});
}

//Активация/деактивация фото
function activateDeactivate(socket, data, cb) {
	var user = socket.handshake.session.user;
	if (!user || user.role < 5) {
		return cb({message: msg.deny, error: true});
	}
	if (!data || !Utils.isType('object', data)) {
		return cb({message: 'Bad params', error: true});
	}
	var cid = Number(data.cid),
		makeDisabled = !!data.disable;

	if (!cid) {
		return cb({message: msg.notExists, error: true});
	}

	Photo.findOne({cid: cid}, function createInNewModel(err, photo) {
		if (err) {
			return cb({message: err.message, error: true});
		}
		if (!photo) {
			return cb({message: msg.notExists, error: true});
		}
		if (makeDisabled && photo.s === 7 || !makeDisabled && photo.s === 5) {
			return cb({message: msg.anotherStatus, error: true});
		}

		photo.s = makeDisabled ? 7 : 5;
		photo.save(function (err, photoSaved) {
			if (err) {
				return cb({message: err.message, error: true});
			}

			changePublicPhotoExternality(socket, photoSaved, user, !makeDisabled, function (err) {
				if (err) {
					return cb({message: err.message, error: true});
				}
				cb({disabled: makeDisabled});
			});
		});
	});
}

//Отдаем фотографию для её страницы
function givePhoto(socket, data, cb) {
	var cid = Number(data.cid),
		iAm = socket.handshake.session.user,
		fieldSelect = {'frags._id': 0};

	if (!cid) {
		return cb({message: msg.notExists, error: true});
	}

	//Инкрементируем кол-во просмотров только у публичных фото
	//TODO: Сделать инкрементацию только у публичных!
	Photo.findOneAndUpdate({cid: cid}, {$inc: {vdcount: 1, vwcount: 1, vcount: 1}}, {new: true, select: fieldSelect}, function (err, photo) {
		if (err) {
			return cb({message: err && err.message, error: true});
		}

		if (!photo || !photoPermissions.canSee(photo, iAm)) {
			return cb({message: msg.notExists, error: true});
		} else {
			var can;

			if (data.checkCan) {
				//Права надо проверять до популяции пользователя
				can = photoPermissions.getCan(photo, iAm);
			}

			step(
				function () {
					var user = _session.getOnline(null, photo.user),
						paralellUser = this.parallel();

					if (user) {
						photo = photo.toObject({getters: true});
						photo.user = {
							login: user.login, avatar: user.avatar, disp: user.disp, ranks: user.ranks || [], sex: user.sex, online: true
						};
						paralellUser(null, photo);
					} else {
						photo.populate({path: 'user', select: {_id: 0, login: 1, avatar: 1, disp: 1, ranks: 1, sex: 1}}, function (err, photo) {
							paralellUser(err, photo && photo.toObject({getters: true}));
						});
					}
					regionController.getObjRegionList(photo, {_id: 0, cid: 1, title_en: 1, title_local: 1}, this.parallel());

					if (iAm) {
						UserSubscr.findOne({obj: photo._id, user: iAm._id}, {_id: 0}, this.parallel());
					}
				},
				function (err, photo, regions, subscr) {
					if (err) {
						return cb({message: err && err.message, error: true});
					}

					if (subscr) {
						photo.subscr = true;
					}

					for (var i = 0; i < 5; i++) {
						delete photo['r' + i];
					}
					if (regions.length) {
						photo.regions = regions;
					}

					if (!iAm || !photo.ccount) {
						delete photo._id;
						cb({photo: photo, can: can});
					} else {
						commentController.getNewCommentsCount([photo._id], iAm._id, null, function (err, countsHash) {
							if (err) {
								return cb({message: err && err.message, error: true});
							}
							if (countsHash[photo._id]) {
								photo.ccount_new = countsHash[photo._id];
							}
							delete photo._id;
							cb({photo: photo, can: can});
						});
					}
				}
			);
		}
	});
}

//Отдаем последние публичные фотографии на главной для анонимов в memoized
var givePhotosPublicIndex = (function () {
	var options = {lean: true, sort: {adate: -1}, skip: 0, limit: 29};

	return Utils.memoizeAsync(function (handler) {
		Photo.find({}, compactFields, options, handler);
	}, ms('30s'));
}());

//Отдаем последние публичные "Где это?" фотографии для главной
var givePhotosPublicNoGeoIndex = (function () {
	var options = {lean: true, sort: {adate: -1}, skip: 0, limit: 29};

	return Utils.memoizeAsync(function (handler) {
		Photo.find({geo: null}, compactFields, options, handler);
	}, ms('30s'));
}());

//Отдаем полную публичную галерею в компактном виде
function givePhotosPublic(iAm, data, cb) {
	if (!Utils.isType('object', data)) {
		return cb({message: 'Bad params', error: true});
	}

	var skip = Math.abs(Number(data.skip)) || 0,
		limit = Math.min(data.limit || 40, 100),
		filter = data.filter || {};

	step(
		function () {
			var query = {},
				fieldsSelect = iAm ? compactFieldsId : compactFields;

			if (filter.nogeo) {
				query.geo = null;
			} else {
				if (iAm) {
					_.assign(query, _session.us[iAm.login].rquery);
				}
			}
			console.log(query);
			Photo.find(query, fieldsSelect, {lean: true, skip: skip, limit: limit, sort: {adate: -1}}, this.parallel());
			Photo.count(query, this.parallel());
		},
		finishOrNewCommentsCount
	);

	function finishOrNewCommentsCount(err, photos, count) {
		if (err || !photos) {
			return cb({message: err && err.message || 'Photos does not exist', error: true});
		}

		if (!iAm || !photos.length) {
			//Если аноним или фотографий нет, сразу возвращаем
			finish(null, photos);
		} else {
			//Если пользователь залогинен, заполняем кол-во новых комментариев для каждого объекта
			commentController.fillNewCommentsCount(photos, iAm._id, null, finish);
		}

		function finish(err, photos) {
			if (err) {
				return cb({message: err.message, error: true});
			}
			if (iAm) {
				for (var i = photos.length; i--;) {
					delete photos[i]._id;
				}
			}
			cb({photos: photos, count: count, skip: skip});
		}
	}
}


//Отдаем последние фотографии, ожидающие подтверждения
function givePhotosForApprove(iAm, data, cb) {
	var query = {s: 1};

	if (!iAm || iAm.role < 5) {
		return cb({message: msg.deny, error: true});
	}
	if (!Utils.isType('object', data)) {
		return cb({message: 'Bad params', error: true});
	}
	if (iAm.role === 5) {
		_.assign(query, _session.us[iAm.login].mod_rquery);
	}

	Photo.find(query, compactFields, {lean: true, sort: {ldate: -1}, skip: data.skip || 0, limit: Math.min(data.limit || 20, 100)}, cb);
}

//Отдаем галерею пользователя в компактном виде
function giveUserPhotos(iAm, data, cb) {
	User.collection.findOne({login: data.login}, {_id: 1, pcount: 1}, function (err, user) {
		if (err || !user) {
			return cb({message: err && err.message || 'Such user does not exist', error: true});
		}
		var query = {user: user._id},
			noPublic = iAm && (iAm.role > 4 || user._id.equals(iAm._id)),
			skip = data.skip || 0,
			limit = Math.min(data.limit || 20, 100),
			filter = data.filter || {},
			fieldsSelect = iAm ? compactFieldsId : compactFields;

		step(
			function () {
				var query = buildPhotosQuery(filter, user._id, iAm);
				query.user = user._id;
				console.log(JSON.stringify(query));
				Photo.find(query, fieldsSelect, {lean: true, sort: {stamp: -1}, skip: skip, limit: limit}, this.parallel());
				Photo.count(query, this.parallel());
			},
			function (err, photos, count) {
				if (err || !photos) {
					return cb({message: err && err.message || msg.notExists, error: true});
				}

				if (!iAm || !photos.length) {
					//Если аноним или фотографий нет, сразу возвращаем
					finish(null, photos);
				} else {
					//Если пользователь залогинен, заполняем кол-во новых комментариев для каждого объекта
					commentController.fillNewCommentsCount(photos, iAm._id, null, finish);
				}

				function finish(err, photos) {
					if (err) {
						return cb({message: err.message, error: true});
					}
					if (iAm) {
						for (var i = photos.length; i--;) {
							delete photos[i]._id;
						}
					}
					cb({photos: photos, count: count, skip: skip});
				}
			}
		);
	});
}

//Берем массив до и после указанной фотографии пользователя указанной длины
function giveUserPhotosAround(socket, data, cb) {
	var user = socket.handshake.session.user,
		cid = Number(data && data.cid),
		limitL = Math.min(Number(data.limitL), 100),
		limitR = Math.min(Number(data.limitR), 100);

	if (!cid || (!limitL && !limitR)) {
		return cb({message: 'Bad params', error: true});
	}

	findPhoto({cid: cid}, {_id: 0, user: 1, adate: 1, ldate: 1}, user, function (err, photo) {
		if (err || !photo || !photo.user) {
			return cb({message: msg.notExists, error: true});
		}

		step(
			function () {
				var query = {user: photo.user},
					noPublic = user && (user.role > 4 || photo.user.equals(user._id));

				if (limitL) {
					if (noPublic) {
						//Если текущая фотография новая, то stamp должен быть увеличен на 10 лет
						query.stamp = {$gt: photo.adate || new Date(photo.ldate.getTime() + shift10y)};
						findPhotosAll(query, compactFields, {sort: {stamp: 1}, limit: limitL}, user, this.parallel());
					} else {
						query.adate = {$gt: photo.adate};
						Photo.find(query, compactFields, {lean: true, sort: {adate: 1}, limit: limitL}, this.parallel());
					}
				} else {
					this.parallel()(null, []);
				}

				if (limitR) {
					if (noPublic) {
						query.stamp = {$lt: photo.adate || new Date(photo.ldate.getTime() + shift10y)};
						findPhotosAll(query, compactFields, {sort: {stamp: -1}, limit: limitR}, user, this.parallel());
					} else {
						query.adate = {$lt: photo.adate};
						Photo.find(query, compactFields, {lean: true, sort: {adate: -1}, limit: limitR}, this.parallel());
					}
				} else {
					this.parallel()(null, []);
				}
			},
			function (err, photosL, photosR) {
				if (err) {
					return cb({message: err.message, error: true});
				}
				cb({left: photosL || [], right: photosR || []});
			}
		);
	});
}

//Берем массив ближайших фотографий
function giveNearestPhotos(data, cb) {
	if (!data || !Utils.geoCheck(data.geo)) {
		return cb({message: 'Bad params', error: true});
	}

	Photo.find({geo: {$near: data.geo.reverse(), $maxDistance: 2000}}, compactFields, {lean: true, limit: Math.min(Number(data.limit), 50)}, cb);
}

//Отдаем непубличные фотографии
function giveUserPhotosPrivate(socket, data, cb) {
	var user = socket.handshake.session.user;
	if (!user || (user.role < 5 && user.login !== data.login)) {
		return cb({message: msg.deny, error: true});
	}
	User.getUserID(data.login, function (err, userid) {
		if (err) {
			return cb({message: err && err.message, error: true});
		}

		step(
			function () {
				var query = {user: userid};
				if (data.startTime || data.endTime) {
					query.adate = {};
					if (data.startTime) {
						query.adate.$gte = new Date(data.startTime);
					}
					if (data.endTime) {
						query.adate.$lte = new Date(data.endTime);
					}
				}

				PhotoFresh.collection.find({user: userid}, compactFields, {sort: {ldate: -1}}, this.parallel());
				PhotoDis.collection.find(query, compactFields, this.parallel());
				if (user.role > 9) {
					PhotoDel.collection.find(query, compactFields, this.parallel());
				}
			},
			Utils.cursorsExtract,
			function (err, fresh, disabled, del) {
				if (err) {
					return cb({message: err && err.message, error: true});
				}
				var res = {fresh: fresh || [], disabled: disabled || [], len: fresh.length + disabled.length},
					i;
				for (i = res.fresh.length; i--;) {
					res.fresh[i].fresh = true;
				}
				for (i = res.disabled.length; i--;) {
					res.disabled[i].disabled = true;
				}
				if (user.role > 9) {
					res.del = del || [];
					res.len += res.del.length;
					for (i = res.del.length; i--;) {
						res.del[i].del = true;
					}
				}
				cb(res);
			}
		);
	});
}

//Отдаем новые фотографии
function givePhotosFresh(socket, data, cb) {
	var user = socket.handshake.session.user;
	if (!user ||
		(!data.login && user.role < 5) ||
		(data.login && user.role < 5 && user.login !== data.login)) {
		return cb({message: msg.deny, error: true});
	}
	if (!data || !Utils.isType('object', data)) {
		return cb({message: 'Bad params', error: true});
	}

	step(
		function () {
			if (data.login) {
				User.getUserID(data.login, this);
			} else {
				this();
			}
		},
		function (err, userid) {
			if (err) {
				return cb({message: err && err.message, error: true});
			}
			var criteria = {s: 0};
			if (userid) {
				criteria.user = userid;
			}
			if (data.after) {
				criteria.ldate = {$gt: new Date(data.after)};
			}
			Photo.collection.find(criteria, compactFields, {skip: data.skip || 0, limit: Math.min(data.limit || 100, 100)}, this);
		},
		Utils.cursorExtract,
		function (err, photos) {
			if (err) {
				return cb({message: err && err.message, error: true});
			}
			for (var i = photos.length; i--;) {
				photos[i].fresh = true;
			}
			cb({photos: photos || []});
		}
	);
}

//Отдаем разрешенные can для фото
function giveCanPhoto(socket, data, cb) {
	var user = socket.handshake.session.user,
		cid = Number(data.cid);

	if (isNaN(cid)) {
		return cb({message: msg.notExists, error: true});
	}
	if (user) {
		Photo.findOne({cid: cid}, {_id: 0, user: 1}, function (err, photo) {
			if (err) {
				return cb({message: err && err.message, error: true});
			}
			cb({can: photoPermissions.getCan(photo, user)});
		});
	} else {
		cb({});
	}
}

//Сохраняем информацию о фотографии
function savePhoto(socket, data, cb) {
	var user = socket.handshake.session.user,
		cid = Number(data.cid),
		photoOldObj,
		newValues,
		oldGeo,
		newGeo,
		sendingBack = {regions: []};

	if (!user) {
		return cb({message: msg.deny, error: true});
	}
	if (!Utils.isType('object', data) || !Number(data.cid)) {
		return cb({message: 'Bad params', error: true});
	}

	findPhoto({cid: cid}, {frags: 0}, user, function (err, photo) {
		if (err) {
			return cb({message: err.message, error: true});
		}
		if (!photo) {
			return cb({message: msg.notExists, error: true});
		}
		if (!photoPermissions.getCan(photo, user).edit) {
			return cb({message: msg.deny, error: true});
		}

		photoOldObj = photo.toObject({getters: true});

		//Сразу парсим нужные поля, чтобы далее сравнить их с существующим распарсеным значением
		if (data.desc) {
			data.desc = Utils.inputIncomingParse(data.desc);
		}
		if (data.source) {
			data.source = Utils.inputIncomingParse(data.source);
		}
		if (data.geo && !Utils.geoCheck(data.geo)) {
			delete data.geo;
		}

		//Новые значения действительно изменяемых свойств
		newValues = Utils.diff(_.pick(data, 'geo', 'dir', 'title', 'year', 'year2', 'address', 'desc', 'source', 'author'), photoOldObj);
		if (_.isEmpty(newValues)) {
			return cb({message: 'Nothing to save'});
		}

		if (newValues.geo) {
			Utils.geo.geoToPrecisionRound(newValues.geo);
		} else if (newValues.geo === null) {
			newValues.geo = undefined;
		}
		if (newValues.desc !== undefined) {
			sendingBack.desc = newValues.desc;
		}
		if (newValues.source !== undefined) {
			sendingBack.source = newValues.source;
		}

		oldGeo = photoOldObj.geo;
		newGeo = newValues.geo;

		if (!_.isEqual(oldGeo, newGeo)) {
			if (newGeo) {
				regionController.setObjRegions(photo, newGeo, {_id: 0, cid: 1, title_en: 1, title_local: 1}, function (err, regionsArr) {
					if (err) {
						return cb({message: err.message, error: true});
					}
					sendingBack.regions = regionsArr;
					save();
				});
			} else {
				regionController.clearObjRegions(photo);
				save();
			}
		} else {
			save();
		}

		function save() {
			_.assign(photo, newValues);

			photo.save(function (err, photoSaved) {
				if (err) {
					return cb({message: err.message || 'Save error', error: true});
				}

				var newKeys = Object.keys(newValues),
					oldValues = {}, //Старые значения изменяемых свойств
					i;

				for (i = newKeys.length; i--;) {
					oldValues[newKeys[i]] = photoOldObj[newKeys[i]];
				}

				// Если фото - публичное, у него
				// есть старая или новая координаты и (они не равны или есть чем обновить постер кластера),
				// то запускаем пересчет кластеров этой фотографии
				if (!photoOldObj.fresh && !photoOldObj.disabled && !photoOldObj.del &&
					(!_.isEmpty(oldGeo) || !_.isEmpty(newGeo)) &&
					(!_.isEqual(oldGeo, newGeo) || !_.isEmpty(_.pick(oldValues, 'dir', 'title', 'year', 'year2')))) {
					photoToMap(photo, oldGeo, photoOldObj.year, finish);
				} else {
					finish();
				}

				function finish(err) {
					if (err) {
						return cb({message: 'Photo saved, but ' + err.message, error: true});
					}
					cb({message: 'Photo saved successfully', saved: true, data: sendingBack});
				}
			});
		}
	});
}

//Говорим, что фото готово к подтверждению
function readyPhoto(socket, data, cb) {
	var user = socket.handshake.session.user,
		cid = Number(data);

	if (!user) {
		return cb({message: msg.deny, error: true});
	}
	if (!cid) {
		return cb({message: msg.notExists, error: true});
	}
	step(
		function () {
			Photo.findOne({cid: cid}, this);
		},
		function (err, photo) {
			if (err || !photo) {
				return cb({message: err && err.message || msg.notExists, error: true});
			}
			if (photo.s !== 0) {
				return cb({message: msg.anotherStatus, error: true});
			}
			if (!photoPermissions.getCan(photo, user).edit) {
				return cb({message: msg.deny, error: true});
			}

			if (user.ranks && user.ranks.indexOf('mec_gold') > -1) {
				//Если пользователь - золотой меценат, значит он сразу публикует фото, если таких действий еще менее 100
				UserSelfPublishedPhotos.find({user: user._id}, {_id: 0, photos: 1}, {lean: true}, function (err, obj) {
					if (obj && obj.photos && obj.photos.length >= 100) {
						justSetReady();
					} else {
						approvePhoto(user, cid, function (result) {
							if (result.error) {
								return cb(result);
							}
							cb({message: 'Ok', published: true});
							UserSelfPublishedPhotos.update({user: user._id}, {$push: {photos: photo._id}}, {upsert: true}).exec();
						});
					}
				});
			} else {
				//Если пользователь обычный, то просто ставим флаг готовности
				justSetReady();
			}

			function justSetReady() {
				photo.s = 1;
				photo.save(function finish(err) {
					if (err) {
						return cb({message: err && err.message, error: true});
					}
					cb({message: 'Ok'});
				});
			}
		}
	);
}

//Фотографии и кластеры по границам
function getBounds(data, cb) {
	if (!Utils.isType('object', data) || !Array.isArray(data.bounds) || !data.z) {
		cb({message: 'Bad params', error: true});
		return;
	}

	var year = false,
		i = data.bounds.length;

	// Реверсируем geo границы баунда
	while (i--) {
		data.bounds[i][0].reverse();
		data.bounds[i][1].reverse();
	}

	// Определяем, нужна ли выборка по границам лет
	if (Number(data.year) && Number(data.year2) && data.year >= 1826 && data.year <= 2000 && data.year2 >= data.year && data.year2 <= 2000 && (1 + data.year2 - data.year < 175)) {
		year = true;
	}

	if (data.z < 17) {
		if (year) {
			PhotoCluster.getBoundsByYear(data, res);
		} else {
			PhotoCluster.getBounds(data, res);
		}
	} else {
		step(
			function () {
				var i = data.bounds.length,
					criteria,
					yearCriteria;

				if (year) {
					if (data.year === data.year2) {
						yearCriteria = data.year;
					} else {
						yearCriteria = {$gte: data.year, $lte: data.year2};
					}
				}

				while (i--) {
					criteria = {geo: {$geoWithin: {$box: data.bounds[i]}}};
					if (year) {
						criteria.year = yearCriteria;
					}
					PhotoMap.collection.find(criteria, {_id: 0, cid: 1, geo: 1, file: 1, dir: 1, title: 1, year: 1, year2: 1}, this.parallel());
				}
			},
			function cursors(err) {
				if (err) {
					return cb({message: err && err.message, error: true});
				}
				var i = arguments.length;
				while (i > 1) {
					arguments[--i].toArray(this.parallel());
				}
			},
			function (err, photos) {
				if (err) {
					return cb({message: err && err.message, error: true});
				}
				var i = arguments.length;

				while (i > 2) {
					photos.push.apply(photos, arguments[--i]);
				}
				res(err, photos);
			}
		);
	}

	function res(err, photos, clusters) {
		if (err) {
			return cb({message: err && err.message, error: true});
		}

		// Реверсируем geo
		for (var i = photos.length; i--;) {
			photos[i].geo.reverse();
		}
		cb({photos: photos, clusters: clusters, startAt: data.startAt, z: data.z});
	}
}

//Отправляет выбранные фото на конвертацию
function convertPhotos(socket, data, cb) {
	var user = socket.handshake.session.user,
		cids = [],
		i;

	if (!user || user.role < 10) {
		return cb({message: msg.deny, error: true});
	}
	if (!Array.isArray(data) || !data.length) {
		return cb({message: 'Bad params', error: true});
	}

	for (i = data.length; i--;) {
		data[i].cid = Number(data[i].cid);
		data[i].variants = _.intersection(data[i].variants, [ "a", "d", "h", "m", "q", "s", "x"]);
		if (data[i].cid && data[i].variants.length) {
			cids.push(data[i].cid);
		}
	}
	if (!cids.length) {
		return cb({message: 'Bad params', error: true});
	}

	Photo.update({cid: {$in: cids}}, {$set: {convqueue: true}}, {multi: true}, function (err) {
		if (err) {
			return cb({message: err && err.message, error: true});
		}
		PhotoConverter.addPhotos(data, function (err, addResult) {
			if (err) {
				return cb({message: err && err.message, error: true});
			}
			cb(addResult);
		});
	});
}

//Отправляет все фото выбранных вариантов на конвертацию
function convertPhotosAll(socket, data, cb) {
	var user = socket.handshake.session.user;

	if (!user || user.role < 10) {
		return cb({message: msg.deny, error: true});
	}
	if (!Utils.isType('object', data)) {
		return cb({message: 'Bad params', error: true});
	}
	PhotoConverter.addPhotosAll(data, function (addResult) {
		cb(addResult);
	});
}

/**
 * Находим фотографию
 * @param query
 * @param fieldSelect Выбор полей
 * @param user Пользователь сессии
 * @param cb
 */
function findPhoto(query, fieldSelect, user, cb) {
	Photo.findOne(query, fieldSelect, function (err, photo) {
		if (err) {
			return cb(err);
		}
		if (photoPermissions.canSee(photo, user)) {
			cb(null, photo);
		} else {
			cb(null, null);
		}
	});
}

/**
 * Находим фотографии с учетом прав на статусы
 * @param filter
 * @param forUserId
 * @param iAm Пользователь сессии
 * @param cb
 */
function buildPhotosQuery(filter, forUserId, iAm) {
	var query = {},
		usObj,
		i;

	if (filter.nogeo) {
		query.geo = null;
	}

	if (!iAm) {
		query.s = 5; //Анонимам отдаем только публичные
	} else if (iAm.role < 9) {
		if (forUserId && forUserId.equals(iAm._id)) {
			//Собственную галерею отдаем без удаленных и если фильтр не указан - всю
			query.s = {$ne: 9};
			//if (Array.isArray(filter.r) && filter.r.length) { }
		} else {
			usObj = _session.us[iAm.login];

			//Если фильтр не указан - отдаем по регионам
			if (filter.r === undefined && iAm.regions.length) {
				_.assign(query, usObj.rquery);
			} //else if (Array.isArray(filter.r) && filter.r.length) {}

			if (iAm.role < 5) {
				query.s = 5; //Ниже чем модераторам региона отдаем только публичные
			} else if (iAm.role === 5) {
				if (!iAm.mod_regions.length || usObj.mod_regions_equals) {
					//Глобальным модераторам и региональным, у которых совпадают регионы модерирования с собственными,
					//отдаем фотографии без удаленных
					query.s = {$ne: 9};
				} else {
					//Региональным модераторам отдаем в своих регионах без удаленных,
					//в остальных (на которые подписаны) - только публичные
					var regions_pub = [],
						regions_mod = [];

					for (i in usObj.rhash) {
						if (usObj.rhash.hasOwnProperty(i)){
							if (usObj.rhash.mod_rhash[i]) {
								regions_mod.push(usObj.rhash[i]);
							} else {
								regions_pub.push(usObj.rhash[i]);
							}
						}
					}

					query.$or = [
						{s: 5},
						{s: {$ne: 9}}
					];
					_.assign(query.$or[0], regionController.buildQuery(regions_pub));
					_.assign(query.$or[1], regionController.buildQuery(regions_mod));
				}
			}
		}
	}
	return query;
}
/**
 * Находим фотографии с учетом прав на статусы
 * @param query
 * @param fieldSelect Выбор полей
 * @param options
 * @param iAm Пользователь сессии
 * @param cb
 */
function findPhotos(query, fieldSelect, options, iAm, cb) {
	var queryPublicOr;

	if (!iAm) {
		query.s = 5; //Анонимам отдаем только публичные
	} else if (iAm.role < 9) {
		if (query.user && query.user.equals(iAm._id)) {
			query.s = {$ne: 9}; //Собственную галерею отдаем без удаленных
		} else if (iAm.role < 5) {
			query.s = 5; //Ниже чем модераторам региона отдаем только публичные
		} else if (iAm.role === 5) {
			if (!iAm.mod_regions.length) {
				query.s = {$ne: 9}; //Глобальным модераторам отдаем без удаленных все фотографии
			} else {
				//Региональным модераторам отдаем в своих регионах без удаленных,
				//в остальных (на которые подписаны) - только публичные
				queryPublicOr = query.$or || {};
				query.$or = [
					{s: 5},
					{s: {$ne: 9}}
				];
				console.log(queryPublicOr);
				console.log(_session.us[iAm.login].mod_rquery);
				_.assign(query.$or[1], _session.us[iAm.login].mod_rquery);
			}
		}
	}

	options = options || {};
	options.lean = true;
	Photo.find(query, fieldSelect, options, function (err, photos) {
		cb(err, photos);
	});
}
/**
 * Считаем фотографии по сквозной таблице
 * @param query
 * @param iAm Пользователь сессии
 * @param cb
 */
function countPhotos(query, iAm, cb) {
	var queryPublicOr;

	if (!iAm) {
		query.s = 5; //Анонимам отдаем только публичные
	} else if (iAm.role < 9) {
		if (query.user && query.user.equals(iAm._id)) {
			query.s = {$ne: 9}; //Собственную галерею отдаем без удаленных
		} else if (iAm.role < 5) {
			query.s = 5; //Ниже чем модераторам региона отдаем только публичные
		} else if (iAm.role === 5) {
			if (!iAm.mod_regions.length) {
				query.s = {$ne: 9}; //Глобальным модераторам отдаем без удаленных все фотографии
			} else {
				//Региональным модераторам отдаем в своих регионах без удаленных,
				//в остальных (на которые подписаны) - только публичные
				queryPublicOr = query.$or || {};
				query.$or = [
					{s: 5},
					{s: {$ne: 9}}
				];
				console.log(queryPublicOr);
				console.log(_session.us[iAm.login].mod_rquery);
				_.assign(query.$or[1], _session.us[iAm.login].mod_rquery);
			}
		}
	}

	Photo.count(query, cb);
}

/**
 * Находим фотографии по сквозной таблице, независимо от статуса
 * @param query
 * @param fieldSelect Выбор полей
 * @param options
 * @param user Пользователь сессии
 * @param cb
 */
var findPhotosAll = (function () {
	function findInCollection(model, arr, fieldSelect, cb) {
		if (arr.length) {
			model.find({_id: {$in: arr}}, fieldSelect, {lean: true}, cb);
		} else {
			cb(null, []);
		}
	}

	function stateCheck(source, fresh, pub, dis, del) {
		var item,
			i;
		for (i = source.length; i--;) {
			item = source[i];
			if (item.state === 1) {
				fresh.push(item.photo);
			} else if (item.state === 5) {
				pub.push(item.photo);
			} else if (item.state === 7) {
				dis.push(item.photo);
			} else if (item.state === 9) {
				del.push(item.photo);
			}
		}
	}

	return function (query, fieldSelect, options, user, cb) {
		var photoSort;
		step(
			function () {
				if (!user.role || user.role < 10) {
					query.state = {$ne: 9}; //Не обладающие ролью админа не могут видеть удаленные фотографии
				}
				options = options || {};
				options.lean = true;
				PhotoSort.find(query, {_id: 0, photo: 1, state: 1}, options, this);
			},
			function (err, pSort) {
				if (err) {
					cb(err);
				}
				var fresh = [],
					pub = [],
					dis = [],
					del = [];

				//Если в выборе нет _id, то включаем его, т.к. он нужен для меппинга
				if (!fieldSelect._id) {
					fieldSelect = _.clone(fieldSelect);
					fieldSelect._id = 1;
				}

				stateCheck(pSort, fresh, pub, dis, del);
				findInCollection(PhotoFresh, fresh, fieldSelect, this.parallel());
				findInCollection(Photo, pub, fieldSelect, this.parallel());
				findInCollection(PhotoDis, dis, fieldSelect, this.parallel());
				if (user.role > 9) {
					findInCollection(PhotoDel, del, fieldSelect, this.parallel());
				}
				photoSort = pSort;
			},
			function (err, fresh, pub, dis, del) {
				if (err) {
					cb(err);
				}
				var res = [],
					photosHash = {},
					item,
					i;

				for (i = fresh.length; i--;) {
					item = fresh[i];
					item.fresh = true;
					photosHash[item._id] = item;
				}
				for (i = pub.length; i--;) {
					item = pub[i];
					photosHash[item._id] = item;
				}
				for (i = dis.length; i--;) {
					item = dis[i];
					item.disabled = true;
					photosHash[item._id] = item;
				}
				if (del && del.length) {
					for (i = del.length; i--;) {
						item = del[i];
						item.del = true;
						photosHash[item._id] = item;
					}
				}

				for (i = photoSort.length; i--;) {
					item = photosHash[photoSort[i].photo];
					if (item) {
						res.unshift(item);
					}
				}
				cb(err, res);
			}
		);
	};
}());

/**
 * Считаем фотографии по сквозной таблице
 * @param query
 * @param user Пользователь сессии
 * @param cb
 */
var countPhotosAll = (function () {
	return function (query, user, cb) {
		if (user.role > 4) {
			var notin = [];

			if (user.role < 10) {
				notin.push(9); //Не обладающие ролью админа не могут видеть удаленные фотографии
			}
			if (notin.length) {
				query.state = {$nin: notin};
			}
		} else {
			query.state = 5;
		}
		PhotoSort.count(query, cb);
	};
}());


//Обнуляет статистику просмотров за день и неделю
var planResetDisplayStat = (function () {
	function resetStat() {
		var setQuery = {vdcount: 0},
			needWeek = moment().day() === 1; //Начало недели - понедельник

		if (needWeek) {
			setQuery.vwcount = 0;
		}
		Photo.update({s: {$in: [5, 7, 9]}}, {$set: setQuery}, {multi: true}, function (err, count) {
			planResetDisplayStat();
			if (err) {
				return logger.error(err);
			}
			logger.info('Reset day' + (needWeek ? ' and week ' : ' ') + 'display statistics for %s photos', count);
		});
	}

	return function () {
		setTimeout(resetStat, moment().add('d', 1).startOf('day').diff(moment()) + 2000);
	};
}());


module.exports.loadController = function (app, db, io) {
	logger = log4js.getLogger("photo.js");

	Settings = db.model('Settings');
	User = db.model('User');
	Photo = db.model('Photo');
	PhotoMap = db.model('PhotoMap');
	Counter = db.model('Counter');
	Comment = db.model('Comment');
	UserSubscr = db.model('UserSubscr');

	UserCommentsView = db.model('UserCommentsView');
	UserSelfPublishedPhotos = db.model('UserSelfPublishedPhotos');

	PhotoCluster.loadController(app, db, io);
	PhotoConverter.loadController(app, db, io);

	planResetDisplayStat(); //Планируем очистку статистики

	io.sockets.on('connection', function (socket) {
		var hs = socket.handshake;

		socket.on('createPhoto', function (data) {
			createPhotos(socket, data, function (createData) {
				if (!createData.error && createData.cids && createData.cids.length) {
					PhotoConverter.addPhotos(createData.cids);
				}
				socket.emit('createPhotoCallback', createData);
			});
		});

		socket.on('removePhoto', function (data) {
			removePhoto(socket, data, function (resultData) {
				socket.emit('removePhotoCallback', resultData);
			});
		});
		socket.on('removePhotoInc', function (data) {
			removePhotoIncoming(socket, data, function (err) {
				socket.emit('removePhotoIncCallback', {error: !!err});
			});
		});

		socket.on('approvePhoto', function (data) {
			if (hs.session.user && hs.session.user.role > 4) {
				approvePhoto(hs.session.user, data, function (resultData) {
					socket.emit('approvePhotoResult', resultData);
				});
			} else {
				socket.emit('approvePhotoResult', {message: msg.deny, error: true});
			}
		});

		socket.on('disablePhoto', function (data) {
			activateDeactivate(socket, data, function (resultData) {
				socket.emit('disablePhotoResult', resultData);
			});
		});

		socket.on('givePhoto', function (data) {
			givePhoto(socket, data, function (resultData) {
				socket.emit('takePhoto', resultData);
			});
		});

		socket.on('givePhotosPublicIndex', function () {
			if (hs.session.user) {
				givePhotosPublic(hs.session.user, {skip: 0, limit: 29}, function (resultData) {
					socket.emit('takePhotosPublicIndex', resultData);
				});
			} else {
				givePhotosPublicIndex(function (err, photos) {
					socket.emit('takePhotosPublicIndex', err ? {message: err.message, error: true} : {photos: photos});
				});
			}
		});

		socket.on('givePhotosPublicNoGeoIndex', function () {
			if (hs.session.user) {
				givePhotosPublic(hs.session.user, {skip: 0, limit: 29, filter: {nogeo: true}}, function (resultData) {
					socket.emit('takePhotosPublicNoGeoIndex', resultData);
				});
			} else {
				givePhotosPublicNoGeoIndex(function (err, photos) {
					socket.emit('takePhotosPublicNoGeoIndex', err ? {message: err.message, error: true} : {photos: photos});
				});
			}
		});

		socket.on('givePhotosPublic', function (data) {
			givePhotosPublic(hs.session.user, data, function (resultData) {
				socket.emit('takePhotosPublic', resultData);
			});
		});

		socket.on('givePhotosForApprove', function (data) {
			givePhotosForApprove(hs.session.user, data, function (err, photos) {
				socket.emit('takePhotosForApprove', err ? {message: err.message, error: true} : {photos: photos});
			});
		});

		socket.on('giveUserPhotos', function (data) {
			giveUserPhotos(hs.session.user, data, function (resultData) {
				socket.emit('takeUserPhotos', resultData);
			});
		});

		socket.on('giveUserPhotosAround', function (data) {
			giveUserPhotosAround(socket, data, function (resultData) {
				socket.emit('takeUserPhotosAround', resultData);
			});
		});

		socket.on('giveUserPhotosPrivate', function (data) {
			giveUserPhotosPrivate(socket, data, function (resultData) {
				socket.emit('takeUserPhotosPrivate', resultData);
			});
		});

		socket.on('givePhotosFresh', function (data) {
			givePhotosFresh(socket, data, function (resultData) {
				socket.emit('takePhotosFresh', resultData);
			});
		});

		socket.on('giveNearestPhotos', function (data) {
			giveNearestPhotos(data, function (err, photos) {
				socket.emit('takeNearestPhotos', err ? {message: err.message, error: true} : {photos: photos || []});
			});
		});

		socket.on('giveCanPhoto', function (data) {
			giveCanPhoto(socket, data, function (resultData) {
				socket.emit('takeCanPhoto', resultData);
			});
		});

		socket.on('savePhoto', function (data) {
			savePhoto(socket, data, function (resultData) {
				socket.emit('savePhotoResult', resultData);
			});
		});

		socket.on('readyPhoto', function (data) {
			readyPhoto(socket, data, function (resultData) {
				socket.emit('readyPhotoResult', resultData);
			});
		});

		socket.on('getBounds', function (data) {
			getBounds(data, function (resultData) {
				socket.emit('getBoundsResult', resultData);
			});
		});

		socket.on('convertPhotos', function (data) {
			convertPhotos(socket, data, function (resultData) {
				socket.emit('convertPhotosResult', resultData);
			});
		});

		socket.on('convertPhotosAll', function (data) {
			convertPhotosAll(socket, data, function (resultData) {
				socket.emit('convertPhotosAllResult', resultData);
			});
		});
	});
};
module.exports.findPhoto = findPhoto;
module.exports.findPhotos = findPhotos;